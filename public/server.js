// server.js - 后端核心代码

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { parse } = require('node-html-parser');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// YouTube API 配置
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY
});

// OpenAI 配置 (如果需要 AI 增强功能)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Supabase 配置 (用于缓存和存储)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 提取字幕的 API 端点
app.post('/api/extract-subtitle', async (req, res) => {
  try {
    const { url, language = 'auto' } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: '请提供有效的 YouTube 链接' });
    }
    
    // 从 URL 中提取视频 ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: '无效的 YouTube 链接' });
    }
    
    console.log(`处理视频 ID: ${videoId}, 请求语言: ${language}`);
    
    // 检查缓存中是否已有此视频的字幕
    const { data: cachedData, error: cacheError } = await supabase
      .from('subtitles')
      .select('*')
      .eq('video_id', videoId)
      .eq('language', language === 'auto' ? 'en' : language)
      .single();
    
    if (cachedData && !cacheError) {
      console.log(`从缓存获取字幕数据: ${videoId}`);
      return res.json({
        videoInfo: cachedData.video_info,
        subtitles: cachedData.subtitles,
        summary: cachedData.summary,
        fromCache: true
      });
    }
    
    // 获取视频信息
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(videoId);
      console.log('成功获取视频信息');
    } catch (error) {
      console.error('获取视频信息失败:', error);
      return res.status(500).json({ error: '获取视频信息失败: ' + error.message });
    }
    
    // 获取字幕
    let subtitles;
    let subtitleLanguage = language;
    
    try {
      // 尝试获取指定语言的字幕
      subtitles = await getVideoSubtitles(videoId, language);
      console.log(`获取到 ${subtitles.length} 条字幕，语言: ${language}`);
      
      // 如果指定语言没有字幕且设置为自动，则尝试获取英文字幕
      if ((subtitles.length === 0 || !subtitles) && language === 'auto') {
        console.log('尝试获取英文字幕');
        subtitles = await getVideoSubtitles(videoId, 'en');
        subtitleLanguage = 'en';
      }
      
      // 如果英文字幕也没有，则尝试获取任何可用的字幕
      if ((subtitles.length === 0 || !subtitles) && language === 'auto') {
        console.log('尝试获取任何可用的字幕');
        subtitles = await getVideoSubtitlesAny(videoId);
      }
      
      if (!subtitles || subtitles.length === 0) {
        return res.status(404).json({ error: '未找到字幕，请确认视频包含字幕' });
      }
    } catch (error) {
      console.error('获取字幕失败:', error);
      return res.status(500).json({ error: '获取字幕失败: ' + error.message });
    }
    
    // 处理字幕 - 合并相邻的短句，优化阅读体验
    const processedSubtitles = processSubtitles(subtitles);
    
    // 生成摘要 (如果配置了 OpenAI API)
    let summary = null;
    if (process.env.OPENAI_API_KEY) {
      try {
        summary = await generateSummary(processedSubtitles, videoInfo.title);
        console.log('成功生成摘要');
      } catch (error) {
        console.error('生成摘要失败:', error);
        // 摘要生成失败不影响主要功能，继续执行
      }
    }
    
    // 将结果存入缓存
    try {
      const { error: insertError } = await supabase
        .from('subtitles')
        .insert({
          video_id: videoId,
          language: subtitleLanguage,
          video_info: videoInfo,
          subtitles: processedSubtitles,
          summary: summary,
          created_at: new Date()
        });
      
      if (insertError) {
        console.error('缓存字幕数据失败:', insertError);
      } else {
        console.log('成功缓存字幕数据');
      }
    } catch (error) {
      console.error('存储缓存时出错:', error);
      // 缓存失败不影响主要功能，继续执行
    }
    
    res.json({
      videoInfo,
      subtitles: processedSubtitles,
      summary,
      fromCache: false
    });
  } catch (error) {
    console.error('处理请求时出错:', error);
    res.status(500).json({ error: '获取字幕时出错: ' + error.message });
  }
});

// 从 URL 中提取视频 ID
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// 获取视频信息
async function getVideoInfo(videoId) {
  try {
    console.log('正在通过 YouTube API 获取视频信息...');
    const response = await youtube.videos.list({
      part: 'snippet,contentDetails,statistics',
      id: videoId
    });
    
    const videoData = response.data.items[0];
    if (!videoData) {
      console.log('未找到视频信息，尝试备用方法');
      throw new Error('未找到视频信息');
    }
    
    const snippet = videoData.snippet;
    const contentDetails = videoData.contentDetails;
    const statistics = videoData.statistics;
    
    return {
      title: snippet.title,
      channel: snippet.channelTitle,
      channelId: snippet.channelId,
      thumbnail: snippet.thumbnails.high.url,
      description: snippet.description,
      publishedAt: snippet.publishedAt,
      duration: contentDetails.duration, // ISO 8601 格式
      viewCount: statistics.viewCount,
      likeCount: statistics.likeCount,
      commentCount: statistics.commentCount
    };
  } catch (error) {
    console.error('通过 YouTube API 获取视频信息失败:', error);
    console.log('尝试使用备用方法获取视频信息...');
    
    // 如果 YouTube API 失败，尝试使用备用方法
    return await getVideoInfoFallback(videoId);
  }
}

// 备用方法获取视频信息
async function getVideoInfoFallback(videoId) {
  try {
    console.log('使用备用方法获取视频信息...');
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const html = response.data;
    const $ = cheerio.load(html);
    
    // 尝试从页面中提取信息
    const title = $('meta[property="og:title"]').attr('content') || '未知标题';
    const channel = $('link[itemprop="name"]').attr('content') || '未知频道';
    const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const description = $('meta[property="og:description"]').attr('content') || '无描述';
    
    console.log('成功通过备用方法获取视频信息');
    return {
      title,
      channel,
      channelId: null,
      thumbnail,
      description,
      publishedAt: null,
      duration: null,
      viewCount: null,
      likeCount: null,
      commentCount: null
    };
  } catch (error) {
    console.error('备用方法获取视频信息失败:', error);
    return {
      title: '未知标题',
      channel: '未知频道',
      channelId: null,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      description: '无法获取视频信息',
      publishedAt: null,
      duration: null,
      viewCount: null,
      likeCount: null,
      commentCount: null
    };
  }
}

// 获取指定语言的视频字幕
async function getVideoSubtitles(videoId, language = 'auto') {
  try {
    console.log(`尝试通过 YouTube API 获取${language}字幕...`);
    // 首先尝试使用 YouTube API 获取字幕轨道
    const captionResponse = await youtube.captions.list({
      part: 'snippet',
      videoId: videoId
    });
    
    const captions = captionResponse.data.items;
    if (!captions || captions.length === 0) {
      console.log('通过 API 未找到字幕轨道，尝试备用方法');
      // 如果没有找到字幕轨道，尝试使用备用方法
      return await getSubtitlesFallback(videoId, language);
    }
    
    // 根据请求的语言选择字幕
    let captionId = null;
    let selectedCaption = null;
    
    if (language === 'auto' || language === 'en') {
      // 优先选择英文字幕
      selectedCaption = captions.find(c => c.snippet.language.includes('en'));
    } else if (language === 'zh') {
      // 选择中文字幕
      selectedCaption = captions.find(c => 
        c.snippet.language.includes('zh') || 
        c.snippet.language.includes('cmn') || 
        c.snippet.language.includes('yue')
      );
    } else {
      // 选择指定语言的字幕
      selectedCaption = captions.find(c => c.snippet.language.includes(language));
    }
    
    // 如果没有找到指定语言的字幕，但设置了自动，则选择第一个可用的字幕
    if (!selectedCaption && language === 'auto' && captions.length > 0) {
      selectedCaption = captions[0];
    }
    
    if (!selectedCaption) {
      console.log('未找到可用的字幕 ID，尝试备用方法');
      return await getSubtitlesFallback(videoId, language);
    }
    
    captionId = selectedCaption.id;
    console.log(`找到字幕 ID: ${captionId}, 语言: ${selectedCaption.snippet.language}`);
    
    // 获取字幕内容
    console.log(`尝试下载字幕 ID: ${captionId}`);
    const { data } = await youtube.captions.download({
      id: captionId,
      tfmt: 'srt'
    });
    
    // 解析 SRT 格式的字幕
    console.log('成功获取字幕，开始解析');
    return parseSRT(data);
  } catch (error) {
    console.error('通过 YouTube API 获取字幕失败:', error);
    console.log('尝试使用备用方法获取字幕...');
    // 如果 API 方法失败，尝试使用备用方法
    return await getSubtitlesFallback(videoId, language);
  }
}

// 获取任何可用的字幕
async function getVideoSubtitlesAny(videoId) {
  // 尝试各种语言，直到找到可用的字幕
  const languages = ['en', 'zh', 'es', 'fr', 'de', 'ja', 'ko', 'ru'];
  
  for (const lang of languages) {
    try {
      const subtitles = await getVideoSubtitles(videoId, lang);
      if (subtitles && subtitles.length > 0) {
        console.log(`成功获取 ${lang} 语言的字幕`);
        return subtitles;
      }
    } catch (error) {
      console.log(`获取 ${lang} 语言字幕失败，尝试下一种语言`);
    }
  }
  
  // 如果所有语言都失败，尝试最后的备用方法
  return await getSubtitlesFallbackFinal(videoId);
}

// 备用方法获取字幕
async function getSubtitlesFallback(videoId, language = 'auto') {
  try {
    console.log(`使用备用方法获取${language}字幕...`);
    
    // 构建请求 URL，根据语言参数调整
    let url = `https://www.youtube.com/api/timedtext?lang=${language === 'auto' ? 'en' : language}&v=${videoId}`;
    
    // 如果是自动模式，先尝试获取英文字幕
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const xml = response.data;
    
    if (!xml || xml.trim() === '') {
      console.log('备用方法未找到字幕，尝试第二种备用方法');
      throw new Error('未找到字幕数据');
    }
    
    // 解析 XML 格式的字幕
    const subtitles = parseXMLSubtitles(xml);
    
    if (subtitles.length === 0) {
      console.log('备用方法未解析到字幕，尝试第二种备用方法');
      throw new Error('未能解析字幕数据');
    }
    
    console.log(`备用方法成功获取 ${subtitles.length} 条字幕`);
    return subtitles;
  } catch (error) {
    console.error('备用方法获取字幕失败:', error);
    
    // 尝试第二种备用方法 - 使用第三方服务
    try {
      console.log('使用第三方服务获取字幕...');
      // 这里可以集成其他第三方字幕提取服务
      // 例如 youtubetranscript.com 或其他服务
      
      // 示例：使用 youtubetranscript.com
      const response = await axios.get(`https://youtubetranscript.com/?server_vid=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      const data = response.data;
      
      if (typeof data === 'string' && data.includes('没有字幕')) {
        console.log('第三方服务未找到字幕');
        throw new Error('该视频没有可用的字幕');
      }
      
      // 解析返回的字幕数据
      const subtitles = [];
      if (Array.isArray(data)) {
        data.forEach(item => {
          subtitles.push({
            start: parseFloat(item.start),
            duration: parseFloat(item.duration),
            text: item.text
          });
        });
      }
      
      if (subtitles.length === 0) {
        console.log('第三方服务未解析到字幕');
        throw new Error('未能解析字幕数据');
      }
      
      console.log(`第三方服务成功获取 ${subtitles.length} 条字幕`);
      return subtitles;
    } catch (thirdPartyError) {
      console.error('第三方服务获取字幕失败:', thirdPartyError);
      
      // 如果第三方服务也失败，尝试从页面直接提取
      return await extractSubtitlesFromPage(videoId, language);
    }
  }
}

// 最终备用方法 - 从页面直接提取字幕
async function getSubtitlesFallbackFinal(videoId) {
  try {
    console.log('使用最终备用方法从页面提取字幕...');
    return await extractSubtitlesFromPage(videoId);
  } catch (error) {
    console.error('所有方法获取字幕均失败:', error);
    throw new Error('无法获取视频字幕，请确认视频是否包含字幕');
  }
}

// 从页面提取字幕
async function extractSubtitlesFromPage(videoId, language = 'auto') {
  try {
    console.log('从页面直接提取字幕...');
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const html = response.data;
    
    // 尝试查找包含字幕数据的 JSON
    const regex = /"captionTracks":\s*(\[.*?\])/;
    const match = html.match(regex);
    
    if (!match || !match[1]) {
      throw new Error('页面中未找到字幕数据');
    }
    
    // 解析 JSON 数据
    const jsonStr = match[1].replace(/\\"/g, '"');
    let captionTracks;
    
    try {
      captionTracks = JSON.parse(jsonStr);
    } catch (e) {
      // 如果解析失败，尝试修复 JSON 并重新解析
      const fixedJson = jsonStr
        .replace(/(\w+):/g, '"$1":')
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}');
      captionTracks = JSON.parse(fixedJson);
    }
    
    if (!captionTracks || !captionTracks.length) {
      throw new Error('无法解析字幕轨道数据');
    }
    
    // 根据语言选择字幕轨道
    let captionTrack;
    
    if (language === 'zh') {
      captionTrack = captionTracks.find(track => 
        track.languageCode.includes('zh') || 
        track.languageCode.includes('cmn') || 
        track.languageCode.includes('yue')
      );
    } else if (language === 'auto' || language === 'en') {
      captionTrack = captionTracks.find(track => track.languageCode.includes('en'));
    } else {
      captionTrack = captionTracks.find(track => track.languageCode.includes(language));
    }
    
    // 如果没有找到指定语言的字幕，但设置了自动，则选择第一个可用的字幕
    if (!captionTrack && language === 'auto' && captionTracks.length > 0) {
      captionTrack = captionTracks[0];
    }
    
    if (!captionTrack || !captionTrack.baseUrl) {
      throw new Error('未找到可用的字幕轨道');
    }
    
    // 获取字幕内容
    console.log(`找到字幕轨道，语言: ${captionTrack.languageCode}`);
    const subtitleUrl = captionTrack.baseUrl;
    const subtitleResponse = await axios.get(subtitleUrl);
    const subtitleXml = subtitleResponse.data;
    
    // 解析 XML 格式的字幕
    const subtitles = parseXMLSubtitles(subtitleXml);
    
    if (subtitles.length === 0) {
      throw new Error('未能解析字幕数据');
    }
    
    console.log(`从页面成功提取 ${subtitles.length} 条字幕`);
    return subtitles;
  } catch (error) {
    console.error('从页面提取字幕失败:', error);
    throw error;
  }
}

// 解析 SRT 格式的字幕
function parseSRT(srtContent) {
  const subtitles = [];
  const regex = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n\d+|$)/g;
  
  let match;
  while ((match = regex.exec(srtContent)) !== null) {
    const startTime = timeToSeconds(match[2]);
    const endTime = timeToSeconds(match[3]);
    const text = match[4].replace(/\r?\n/g, ' ').trim();
    
    subtitles.push({
      index: parseInt(match[1]),
      start: startTime,
      end: endTime,
      duration: endTime - startTime,
      text: text
    });
  }
  
  return subtitles;
}

// 解析 XML 格式的字幕
function parseXMLSubtitles(xmlContent) {
  const subtitles = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)".*?>([\s\S]*?)<\/text>/g;
  
  let match;
  let index = 1;
  while ((match = regex.exec(xmlContent)) !== null) {
    const start = parseFloat(match[1]);
    const duration = parseFloat(match[2]);
    const end = start + duration;
    const text = match[3].replace(/&amp;/g, '&')
                         .replace(/&lt;/g, '<')
                         .replace(/&gt;/g, '>')
                         .replace(/&quot;/g, '"')
                         .replace(/&#39;/g, "'")
                         .trim();
    
    subtitles.push({
      index: index++,
      start,
      end,
      duration,
      text
    });
  }
  
  return subtitles;
}

// 处理字幕 - 合并相邻的短句，优化阅读体验
function processSubtitles(subtitles) {
  if (!subtitles || subtitles.length === 0) {
    return [];
  }
  
  const processed = [];
  let current = {
    ...subtitles[0],
    segments: [{ ...subtitles[0] }]
  };
  
  for (let i = 1; i < subtitles.length; i++) {
    const subtitle = subtitles[i];
    const timeDiff = subtitle.start - current.end;
    
    // 如果时间差小于 2 秒，且当前段落不太长，则合并
    if (timeDiff < 2 && current.text.length + subtitle.text.length < 200) {
      current.end = subtitle.end;
      current.duration = current.end - current.start;
      current.text += ' ' + subtitle.text;
      current.segments.push({ ...subtitle });
    } else {
      // 否则开始新段落
      processed.push(current);
      current = {
        ...subtitle,
        segments: [{ ...subtitle }]
      };
    }
  }
  
  // 添加最后一个段落
  processed.push(current);
  
  return processed;
}

// 生成摘要
async function generateSummary(subtitles, title) {
  if (!subtitles || subtitles.length === 0) {
    return null;
  }
  
  // 提取字幕文本
  const fullText = subtitles.map(s => s.text).join(' ');
  
  // 如果文本太短，不生成摘要
  if (fullText.length < 100) {
    return null;
  }
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "你是一个专业的内容摘要助手。请为以下视频内容生成一个简洁的摘要，包括主要观点和关键信息。"
        },
        {
          role: "user",
          content: `视频标题: ${title}\n\n视频内容:\n${fullText.substring(0, 4000)}`
        }
      ],
      max_tokens: 500
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('生成摘要失败:', error);
    return null;
  }
}

// 将时间字符串转换为秒数
function timeToSeconds(timeString) {
  const [hours, minutes, secondsMs] = timeString.split(':');
  const [seconds, ms] = secondsMs.split(',');
  
  return parseInt(hours) * 3600 + 
         parseInt(minutes) * 60 + 
         parseInt(seconds) + 
         parseInt(ms) / 1000;
}

// 健康检查端点
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: '服务器正常运行' });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
