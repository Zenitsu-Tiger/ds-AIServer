import Koa, { Context, Next } from "koa";
import Router from "@koa/router";
import cors from "@koa/cors";
import { PassThrough } from "stream";
// 使用从 node-fetch 导入的类型，确保 fetch 函数签名的兼容性
import type { RequestInfo, RequestInit, Response } from "node-fetch";
// 动态导入 node-fetch，因为它可能是 CommonJS 模块
const fetch = async (
  url: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const { default: fetchFn } = await import("node-fetch");
  // 需要强制转换类型以匹配 node-fetch 的签名
  return fetchFn(url as URL | RequestInfo, init);
};
import { createClient } from "redis"; // 可选: 引入 Redis 客户端库
import dotenv from "dotenv"; // 用于加载环境变量

dotenv.config(); // 加载项目根目录下的 .env 文件中的环境变量

const app = new Koa(); // 创建 Koa 应用实例
const router = new Router(); // 创建 Koa 路由实例

// 从环境变量中获取 DeepSeek API 密钥
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
// DeepSeek API 的聊天接口地址
const deepSeekUrl = "https://api.deepseek.com/chat/completions"; // 确认 DeepSeek API URL

// --- 可选: Redis 连接 ---
let redisClient: ReturnType<typeof createClient> | null = null; // Redis 客户端实例变量
// 异步函数：尝试连接到 Redis 服务器
async function connectRedis() {
  if (!process.env.REDIS_URL) {
    console.log("REDIS_URL not found in .env, skipping Redis connection.");
    return; // 如果 .env 中没有 REDIS_URL，则跳过连接
  }
  // 使用环境变量中的 URL 创建 Redis 客户端
  redisClient = createClient({ url: process.env.REDIS_URL });
  // 监听连接错误事件
  redisClient.on("error", (err: Error) => console.error("Redis Client Error", err));
  try {
    // 尝试连接 Redis
    await redisClient.connect();
    console.log("Connected to Redis");
  } catch (err) {
    // 连接失败处理
    console.error("Failed to connect to Redis:", err);
    redisClient = null; // 连接失败，重置客户端变量
  }
}
// connectRedis(); // 如果需要使用 Redis，取消此行注释以在启动时连接
// ------------------------

interface RequestWithBody extends Context {
  request: Koa.Request & { body: { prompt?: string } };
}

// 定义 POST /chat 路由，用于处理聊天请求
router.post("/chat", async (ctx: RequestWithBody) => {
  // 检查 API 密钥是否已配置
  if (!deepSeekApiKey) {
    ctx.status = 500; // 服务器内部错误状态码
    ctx.body = { error: "DeepSeek API key not configured" }; // 返回错误信息
    return;
  }

  // 从请求体中获取 prompt (用户输入)
  const { prompt } = ctx.request.body;

  // 检查 prompt 是否存在
  if (!prompt) {
    ctx.status = 400; // 客户端请求错误状态码
    ctx.body = { error: "Prompt is required" }; // 返回错误信息
    return;
  }

  // --- 设置 SSE (Server-Sent Events) 响应头 ---
  // 告诉客户端后续发送的是事件流
  ctx.set({
    "Content-Type": "text/event-stream", // 表明是 SSE 流
    "Cache-Control": "no-cache", // 禁止缓存
    Connection: "keep-alive", // 保持连接活跃
  });

  // 创建一个 PassThrough 流，用于将 DeepSeek 的响应数据块写入 Koa 的响应体
  const stream = new PassThrough();

  // 重要：将 PassThrough 流设置为 Koa 的响应体
  // Koa 会自动处理将流内容写入 HTTP 响应的过程
  ctx.body = stream;
  ctx.status = 200; // 明确设置成功状态码

  console.log(`Received prompt: ${prompt}`); // 记录收到的用户输入
  console.log("Streaming response..."); // 提示开始流式响应

  try {
    // --- 调用 DeepSeek API ---
    const response = await fetch(deepSeekUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepSeekApiKey}`, // 使用 API 密钥进行认证
      },
      body: JSON.stringify({
        model: "deepseek-chat", // 指定使用的模型
        messages: [{ role: "user", content: prompt }], // 构建请求体，包含用户消息
        stream: true, // !! 关键：请求 DeepSeek API 以流式模式返回响应
      }),
    });

    // --- 处理 DeepSeek API 的响应 ---
    // 检查响应状态码是否表示成功
    if (!response.ok) {
      const errorBody = await response.text(); // 读取错误响应体
      console.error(
        `DeepSeek API error: ${response.status} ${response.statusText}`,
        errorBody
      );
      // 如果给客户端的流还未结束，则发送一个错误事件
      if (!stream.writableEnded) {
        // 遵循 SSE 格式发送错误事件
        const errorData = { message: `API Error: ${response.statusText}` };
        const errorMessage = `event: error\ndata: ${JSON.stringify(errorData)}\n\n`;
        stream.write(errorMessage);
        stream.end(); // 发生错误，立即结束给客户端的流
      }
      return; // 结束当前请求处理
    }

    // 检查 DeepSeek 返回的响应体是否存在
    if (!response.body) {
      throw new Error("Response body is null");
    }

    // 将 response.body (Node.js 的 ReadableStream) 赋值给一个新变量，以便后续处理
    const responseBody = response.body;

    // --- 使用 Promise 包装对 DeepSeek 响应流的处理 ---\
    // 这是为了更好地管理流的生命周期（data, end, error）和相关的异步操作
    await new Promise<void>((resolve, reject) => {
      // 监听 'data' 事件，当从 DeepSeek 收到数据块时触发
      responseBody.on("data", chunk => {
        try {
          // 将收到的 Buffer 转换为 UTF-8 字符串
          const text = chunk.toString("utf-8");
          // --- 添加详细日志 ---
          // console.log("Raw chunk from DeepSeek:", text); // 打印原始数据块，用于调试
          // --- End log ---
          // DeepSeek 流式响应通常以 "\n\n" 分隔多个 SSE 消息
          const lines = text.split("\n\n");

          // 遍历处理每个潜在的 SSE 消息行
          for (const line of lines) {
            // 检查是否是 SSE 的 data 字段
            if (line.startsWith("data: ")) {
              // 提取 data 字段的 JSON 内容
              const jsonData = line.substring(6).trim();
              // 检查是否是 DeepSeek 表示流结束的特殊标记
              if (jsonData === "[DONE]") {
                // console.log("Received [DONE] marker from DeepSeek.");
                continue; // 如果是 [DONE]，忽略它，等待 'end' 事件
              }

              try {
                // 解析 JSON 数据
                const parsedData = JSON.parse(jsonData);
                // 提取实际的文本内容块
                const contentChunk = parsedData.choices?.[0]?.delta?.content;
                // 如果存在文本内容块
                if (contentChunk) {
                  // 将文本块包装在 { chunk: ... } 对象中
                  const messageData = { chunk: contentChunk };
                  // 格式化为发送给前端的 SSE 消息
                  const messageToSend = `data: ${JSON.stringify(messageData)}\n\n`;
                  // --- 添加详细日志 ---
                  // console.log("Writing chunk to frontend:", messageToSend); // 打印发送给前端的消息，用于调试
                  // --- End log ---
                  // 检查发送给前端的流是否仍然可写
                  if (!stream.writableEnded) {
                    stream.write(messageToSend); // 将消息块写入 PassThrough 流，发送给前端
                  } else {
                    // 如果流已关闭，记录警告
                    // console.warn(
                    //   "Stream already ended, cannot write chunk:",
                    //   contentChunk
                    // );
                  }
                }
              } catch (parseError) {
                // 处理 JSON 解析错误
                console.error(
                  "Failed to parse JSON chunk:",
                  jsonData,
                  parseError
                );
              }
            }
          }
        } catch (chunkProcessingError) {
          // 处理在处理数据块过程中可能出现的其他错误
          console.error("Error processing data chunk:", chunkProcessingError);
          // 这里可以选择是否 reject Promise，取决于错误是否严重到需要中断整个流
          // reject(chunkProcessingError);
        }
      });

      // 监听 'end' 事件，当 DeepSeek 的响应流结束时触发
      responseBody.on("end", () => {
        console.log("DeepSeek stream finished.");
        // 向前端发送一个自定义的 'done' 信号，告知流已正常结束
        const doneData = { done: true };
        const doneMessage = `data: ${JSON.stringify(doneData)}\n\n`;
        // console.log("Writing done signal to frontend:", doneMessage);
        if (!stream.writableEnded) {
          stream.write(doneMessage); // 发送结束信号
        }
        resolve(); // Promise 成功完成
      });

      // 监听 'error' 事件，当 DeepSeek 的响应流发生错误时触发
      responseBody.on("error", err => {
        console.error("DeepSeek stream error:", err);
        // 向前端发送一个 SSE 错误事件
        const errorData = { message: "Error in response stream from DeepSeek" };
        const errorMessage = `event: error\ndata: ${JSON.stringify(errorData)}\n\n`;
        console.log("Writing error signal to frontend:", errorMessage);
        if (!stream.writableEnded) {
          stream.write(errorMessage); // 发送错误信号
        }
        reject(err); // Promise 因错误而失败
      });
    });
    // --- Promise 结束 ---
    // 到这里意味着 DeepSeek 的流处理已完成 (无论是正常结束还是出错)

  } catch (error) {
    // 捕获在 try 块中（例如 fetch 本身失败或 Promise 被 reject）发生的错误
    console.error("Error during fetch setup or stream promise:", error);
    // 如果给客户端的流还未结束，则发送一个通用错误事件
    if (!stream.writableEnded) {
      const finalErrorData = { message: "Internal server error during streaming setup or processing" };
      const finalErrorMessage = `event: error\ndata: ${JSON.stringify(finalErrorData)}\n\n`;
      stream.write(finalErrorMessage);
    }
  } finally {
    // --- 无论成功还是失败，最终都要执行的代码 ---
    // 这个 finally 块会在 new Promise 执行完毕 (resolve 或 reject) 后才执行
    if (!stream.writableEnded) { // 再次检查流是否可写
      stream.end(); // 安全地结束发送给前端的流，确保连接被关闭
    }
    console.log("Response stream to frontend closed.");
  }
});

// --- Koa 应用设置 ---\n
app
  .use(cors()) // 使用 CORS 中间件，允许跨域请求 (开发时通常需要)
  .use(async (ctx: Context, next: Next) => {
    // --- 自定义简易 JSON Body Parser 中间件 ---
    // 仅当请求是 POST 且 Content-Type 是 application/json 时处理
    if (ctx.is("application/json") && ctx.request.method === "POST") {
      try {
        await new Promise<void>((resolve, reject) => {
          let data = ""; // 用于累积请求体数据
          ctx.req.on("data", (chunk: Buffer) => (data += chunk.toString())); // 监听原生请求对象的 data 事件
          ctx.req.on("end", () => { // 监听原生请求对象的 end 事件
            try {
              // 解析累积的 JSON 字符串，并将其挂载到 Koa 的 ctx.request.body 上
              // 使用 as any 来避免 TypeScript 对 ctx.request.body 的严格类型检查
              (ctx.request as any).body = JSON.parse(data);
              resolve(); // 解析成功，继续 Koa 中间件流程
            } catch (e) {
              ctx.status = 400; // JSON 解析失败，设置状态码
              ctx.body = { error: "Invalid JSON body" };
              // 不调用 reject，而是让 Koa 处理错误响应
              resolve(); // 但仍然 resolve Promise 以结束等待
            }
          });
          ctx.req.on("error", (err: Error) => {
            console.error("Request body stream error:", err);
            ctx.status = 500;
            ctx.body = { error: "Error reading request body" };
             // 不调用 reject，而是让 Koa 处理错误响应
            resolve(); // 但仍然 resolve Promise 以结束等待
          });
        });
      } catch (e) {
         // 这个 catch 理论上不会被触发，因为上面总是 resolve
         console.error("Unexpected error in body parser promise:", e);
         ctx.status = 500;
         ctx.body = { error: "Internal server error during body parsing" };
      }
    }
    await next(); // 调用下一个中间件或路由处理器
  })
  .use(router.routes()) // 加载定义好的路由
  .use(router.allowedMethods()); // 处理 OPTIONS 请求和不支持的 HTTP 方法

// 从环境变量获取端口号，如果未设置则默认为 3001
const PORT = process.env.PORT || 3001;
// 启动 Koa 服务器，监听指定端口
const server = app.listen(PORT, () => {
  console.log(`Koa server listening on port ${PORT}`);
});

// --- 服务器级别的连接设置 ---
// 监听 'connection' 事件，当有新的 TCP 连接建立时触发
server.on("connection", socket => {
  // 禁用 Nagle 算法 (TCP_NODELAY)
  // 这使得小的数据包（比如每个 SSE 消息块）能够立即发送，而不是等待缓冲区填满或超时
  // 对于低延迟的流式传输很重要
  socket.setNoDelay(true);
});
