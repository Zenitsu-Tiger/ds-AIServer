import Koa, { Context, Next } from 'koa';
import Router from '@koa/router';
import cors from '@koa/cors';
import { PassThrough } from 'stream';
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const app = new Koa();
const router = new Router();

const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const deepSeekUrl = 'https://api.deepseek.com/chat/completions';

// --- 可选: Redis 连接 ---
let redisClient: ReturnType<typeof createClient> | null = null;
async function connectRedis() {
  if (!process.env.REDIS_URL) {
    console.log("REDIS_URL not found in .env, skipping Redis connection.");
    return;
  }
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err: Error) => console.error('Redis Client Error', err));
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    redisClient = null;
  }
}
// connectRedis(); // 按需启用
// ------------------------

interface RequestWithBody extends Context {
  request: Koa.Request & { body: { prompt?: string } };
}

router.post('/chat', async (ctx: RequestWithBody) => {
  if (!deepSeekApiKey) {
    ctx.status = 500;
    ctx.body = { error: 'DeepSeek API key not configured' };
    return;
  }

  const { prompt } = ctx.request.body;

  if (!prompt) {
    ctx.status = 400;
    ctx.body = { error: 'Prompt is required' };
    return;
  }

  // --- 设置 SSE 响应头 ---
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 创建一个 PassThrough 流将数据写入响应
  const stream = new PassThrough();

  // 关键：设置流响应选项，确保每个数据块立即刷新到客户端
  stream.on('data', (chunk) => {
    ctx.res.write(chunk);
  });

  ctx.respond = false; // 告诉 Koa 我们将手动处理响应
  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', 'text/event-stream');
  ctx.res.setHeader('Cache-Control', 'no-cache');
  ctx.res.setHeader('Connection', 'keep-alive');

  console.log(`Received prompt: ${prompt}`);
  console.log('Streaming response...');

  try {
    const response = await fetch(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`DeepSeek API error: ${response.status} ${response.statusText}`, errorBody);
      if (!stream.writableEnded) {
        stream.write(`event: error\ndata: ${JSON.stringify({ message: `API Error: ${response.statusText}` })}\n\n`);
        stream.end();
      }
      return;
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const responseBody = response.body;

    await new Promise<void>((resolve, reject) => {
      responseBody.on('data', (chunk) => {
        try {
          const text = chunk.toString('utf-8');
          const lines = text.split('\n\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonData = line.substring(6).trim();
              if (jsonData === '[DONE]') {
                console.log('Received [DONE] marker from DeepSeek.');
                continue;
              }

              try {
                const parsedData = JSON.parse(jsonData);
                const contentChunk = parsedData.choices?.[0]?.delta?.content;
                if (contentChunk) {
                  const messageToSend = `data: ${JSON.stringify({ chunk: contentChunk })}\n\n`;
                  if (!stream.writableEnded) {
                    stream.write(messageToSend);
                  } else {
                    console.warn('Stream already ended, cannot write chunk:', contentChunk);
                  }
                }
              } catch (parseError) {
                console.error('Failed to parse JSON chunk:', jsonData, parseError);
              }
            }
          }
        } catch (chunkProcessingError) {
          console.error('Error processing data chunk:', chunkProcessingError);
        }
      });

      responseBody.on('end', () => {
        console.log('DeepSeek stream finished.');
        const doneMessage = `data: ${JSON.stringify({ done: true })}\n\n`;
        if (!stream.writableEnded) {
          stream.write(doneMessage);
        }
        resolve();
      });

      responseBody.on('error', (err) => {
        console.error('DeepSeek stream error:', err);
        const errorMessage = `event: error\ndata: ${JSON.stringify({ message: 'Error in response stream from DeepSeek' })}\n\n`;
        if (!stream.writableEnded) {
          stream.write(errorMessage);
        }
        reject(err);
      });
    });

  } catch (error) {
    console.error('Error during fetch setup or stream promise:', error);
    if (!stream.writableEnded) {
      stream.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal server error during streaming setup or processing' })}\n\n`);
    }
  } finally {
    if (!stream.writableEnded) {
      stream.end();
    }
    ctx.res.end(); // 关键：手动结束响应
    console.log('Response stream to frontend closed.');
  }
});

app
  .use(cors())
  .use(async (ctx: Context, next: Next) => {
    if (ctx.is('application/json') && ctx.request.method === 'POST') {
      await new Promise<void>((resolve, reject) => {
        let data = '';
        ctx.req.on('data', (chunk: Buffer) => data += chunk.toString());
        ctx.req.on('end', () => {
          try {
            (ctx.request as any).body = JSON.parse(data);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        ctx.req.on('error', (err: Error) => reject(err));
      });
    }
    await next();
  })
  .use(router.routes())
  .use(router.allowedMethods());

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Koa server listening on port ${PORT}`);
});

// 设置服务器不缓冲响应
server.on('connection', (socket) => {
  socket.setNoDelay(true);
});
