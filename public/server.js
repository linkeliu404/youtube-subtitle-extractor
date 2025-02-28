// 后端代码 - server.js
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const axios = require('axios');
const { parse } = require('node-html-parser');
const path = require('path');
const dotenv = require('dotenv');

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

// 提取字幕的 API 端点
app.post('/api/extract-subtitle', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: '请提供有效的 YouTube 链接' });
    }
    
    // 从 URL 中提取视频 ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: '无效的 YouTube 链接' });
    }
    
    // 获取视频信息
    const videoInfo = await getVideoInfo(videoId);
    
    // 获取字幕
    const subtitles = await getVideoSubtitles(videoId);
    
    res.json({
      videoInfo,
      subtitles
    });
  } catch (error) {
    console.error('Error extracting subtitles:', error);
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
    const response = await youtube.videos.list({
      part: 'snippet',
      id: videoId
    });
    
    const videoData = response.data.items[0];
    if (!videoData) {
      throw new Error('未找到视频信息');
    }
    
    const snippet = videoData.snippet;
    return {
      title: snippet.title,
      channel: snippet.channelTitle,
      thumbnail: snippet.thumbnails.medium.url,
      description: snippet.description
    };
  } catch (error) {
    console.error('Error fetching video info:', error);
    
    // 如果 YouTube API 失败，尝试使用备用方法
    return await getVideoInfoFallback(videoId);
  }
}

// 备用方法获取视频信息
async function getVideoInfoFallback(videoId) {
  try {
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`);
    const root = parse(response.data);
    
    // 尝试从页面中提取信息
    const title = root.querySelector('meta[property="og:title"]')?.getAttribute('content') || '未知标题';
    const channel = root.querySelector('link[itemprop="name"]')?.getAttribute('content') || '未知频道';
    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    
    return {
      title,
      channel,
      thumbnail,
      description: '无法获取详细描述'
    };
  } catch (error) {
    console.error('Error in fallback video info:', error);
    return {
      title: '未知标题',
      channel: '未知频道',
      thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      description: '无法获取视频信息'
    };
  }
}

// 获取视频字幕
async function getVideoSubtitles(videoId) {
  try {
    // 首先尝试使用 YouTube API 获取字幕轨道
    const captionResponse = await youtube.captions.list({
      part: 'snippet',
      videoId: videoId
    });
    
    const captions = captionResponse.data.items;
    if (!captions || captions.length === 0) {
      // 如果没有找到字幕轨道，尝试使用备用方法
      return await getSubtitlesFallback(videoId);
    }
    
    // 优先选择中文字幕，如果没有则选择英文或第一个可用的字幕
    let captionId = null;
    const zhCaption = captions.find(c => c.snippet.language.includes('zh'));
    const enCaption = captions.find(c => c.snippet.language.includes('en'));
    
    if (zhCaption) {
      captionId = zhCaption.id;
    } else if (enCaption) {
      captionId = enCaption.id;
    } else if (captions.length > 0) {
      captionId = captions[0].id;
    }
    
    if (!captionId) {
      throw new Error('未找到可用的字幕');
    }
    
    // 获取字幕内容
    const { data } = await youtube.captions.download({
      id: captionId,
      tfmt: 'srt'
    });
    
    // 解析 SRT 格式的字幕
    return parseSRT(data);
  } catch (error) {
    console.error('Error fetching subtitles from API:', error);
    // 如果 API 方法失败，尝试使用备用方法
    return await getSubtitlesFallback(videoId);
  }
}

// 备用方法获取字幕
async function getSubtitlesFallback(videoId) {
  try {
    // 使用第三方服务获取字幕
    const response = await axios.get(`https://youtubetranscript.com/?server_vid=${videoId}`);
    const data = response.data;
    
    if (typeof data === 'string' && data.includes('没有字幕')) {
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
    
    return subtitles;
  } catch (error) {
    console.error('Error in fallback subtitles:', error);
    
    // 尝试另一种备用方法
    try {
      const response = await axios.get(`https://www.youtube.com/api/timedtext?lang=zh&v=${videoId}`);
      const xml = response.data;
      
      // 解析 XML 格式的字幕
      return parseXMLSubtitles(xml);
    } catch (innerError) {
      console.error('Error in second fallback:', innerError);
      throw new Error('无法获取视频字幕，请确认视频是否包含字幕');
    }
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
      start: startTime,
      duration: endTime - startTime,
      text: text
    });
  }
  
  return subtitles;
}

// 解析 XML 格式的字幕
function parseXMLSubtitles(xmlContent) {
  const subtitles = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)">([\s\S]*?)<\/text>/g;
  
  let match;
  while ((match = regex.exec(xmlContent)) !== null) {
    const start = parseFloat(match[1]);
    const duration = parseFloat(match[2]);
    const text = match[3].replace(/&amp;/g, '&')
                         .replace(/&lt;/g, '<')
                         .replace(/&gt;/g, '>')
                         .replace(/&quot;/g, '"')
                         .replace(/&#39;/g, "'")
                         .trim();
    
    subtitles.push({
      start,
      duration,
      text
    });
  }
  
  return subtitles;
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

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
