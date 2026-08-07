/**
 * SVAKOM BLE Bridge Server
 * 
 * 中继服务器：接收 MCP/HTTP 指令，bridge.py 轮询取走执行。
 * 部署到 Zeabur/Railway，设置环境变量 BRIDGE_SECRET。
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const SECRET = process.env.BRIDGE_SECRET || '';

// --- 手机 Web Bluetooth 中继页面（同源访问 /toy-next，无需额外 CORS）---
app.get(['/', '/toy', '/toy.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'toy.html'));
});

// --- 指令队列 ---
let commandQueue = [];
let bridgeOnline = false;
let lastPoll = 0;

// --- 鉴权中间件 ---
function checkSecret(req, res, next) {
  const s = req.headers['x-bridge-secret'] || req.query.secret || '';
  if (SECRET && s !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// --- bridge.py 轮询取指令 ---
app.get('/toy-next', checkSecret, (req, res) => {
  lastPoll = Date.now();
  bridgeOnline = true;
  if (commandQueue.length > 0) {
    const cmd = commandQueue.shift();
    return res.json(cmd);
  }
  res.json({ type: 'hello' });
});

// --- 状态查询 ---
app.get('/status', checkSecret, (req, res) => {
  const online = bridgeOnline && (Date.now() - lastPoll < 10000);
  res.json({ bridge_online: online, queue_length: commandQueue.length });
});

// --- 控制指令 API ---
app.post('/command', checkSecret, (req, res) => {
  const cmd = req.body;
  if (!cmd || typeof cmd !== 'object') {
    return res.status(400).json({ error: 'invalid command' });
  }
  // 急停必须越过所有残留动作；普通指令限制队列长度，避免旧动作积压。
  if (cmd.stop) commandQueue = [{ stop: true }];
  else {
    commandQueue.push(cmd);
    if (commandQueue.length > 50) commandQueue = commandQueue.slice(-50);
  }
  res.json({ ok: true, queued: cmd });
});

// --- MCP 协议入口（Streamable HTTP）---
// 简化版：处理 JSON-RPC 请求
app.post('/mcp', checkSecret, (req, res) => {
  const { method, params, id } = req.body;

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'svakom-bridge', version: '1.0.0' }
      }
    });
  }

  if (method === 'notifications/initialized') {
    return res.status(200).json({ jsonrpc: '2.0' });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'vibrate',
            description: 'Control vibration. mode: 1-10 (pattern), strength: 1-10 (intensity). Use strength 0 to stop vibration only.',
            inputSchema: {
              type: 'object',
              properties: {
                mode: { type: 'integer', default: 1, description: 'Vibration pattern 1-10' },
                strength: { type: 'integer', default: 5, description: 'Intensity 1-10' }
              }
            }
          },
          {
            name: 'thrust',
            description: 'Control thrusting/stretching motion. mode: 1-7 (pattern), strength: 1-10 (intensity).',
            inputSchema: {
              type: 'object',
              properties: {
                mode: { type: 'integer', default: 1 },
                strength: { type: 'integer', default: 5 }
              }
            }
          },
          {
            name: 'suck',
            description: 'Control suction. mode: 1-5 (pattern), strength: 1-10 (intensity).',
            inputSchema: {
              type: 'object',
              properties: {
                mode: { type: 'integer', default: 1 },
                strength: { type: 'integer', default: 5 }
              }
            }
          },
          {
            name: 'heat',
            description: 'Turn heating on or off.',
            inputSchema: {
              type: 'object',
              properties: {
                on: { type: 'boolean', default: true }
              }
            }
          },
          {
            name: 'stop',
            description: 'Stop all motors immediately.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'vibrate_pattern',
            description: 'Set vibration pattern (CMD_VIBRATE 0x03). Only affects vibration motor, not suction/thrust. mode: 1-8, level: 1-5.',
            inputSchema: {
              type: 'object',
              properties: {
                mode: { type: 'integer', default: 1, description: 'Pattern 1-8' },
                level: { type: 'integer', default: 3, description: 'Level 1-5' }
              }
            }
          },
          {
            name: 'thrust_cmd',
            description: 'Send thrust command (CMD 0x08). mode: 1-7, strength: 1-10.',
            inputSchema: {
              type: 'object',
              properties: {
                mode: { type: 'integer', default: 1 },
                strength: { type: 'integer', default: 5 }
              }
            }
          },
          {
            name: 'suck_cmd',
            description: 'Send suction command (CMD 0x09). mode: 1-5, strength: 1-10.',
            inputSchema: {
              type: 'object',
              properties: {
                mode: { type: 'integer', default: 1 },
                strength: { type: 'integer', default: 5 }
              }
            }
          },
          {
            name: 'pattern',
            description: 'Execute a timed sequence of actions. Each step: {action, mode, strength, duration}.',
            inputSchema: {
              type: 'object',
              properties: {
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string' },
                      mode: { type: 'integer' },
                      strength: { type: 'integer' },
                      duration: { type: 'number' }
                    }
                  }
                }
              }
            }
          },
          {
            name: 'status',
            description: 'Check if the device bridge is connected.',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    let cmd = {};
    let resultText = '';

    switch (toolName) {
      case 'vibrate': {
        const speed = (args.strength || 5) / 10;
        cmd = { speed, sec: args.duration || 0 };
        resultText = `Vibrate strength=${args.strength || 5} -> queued`;
        break;
      }
      case 'thrust': {
        const speed = (args.strength || 5) / 10;
        cmd = { speed, sec: args.duration || 0 };
        resultText = `Thrust strength=${args.strength || 5} -> queued`;
        break;
      }
      case 'suck': {
        const speed = (args.strength || 5) / 10;
        cmd = { speed, sec: args.duration || 0 };
        resultText = `Suck strength=${args.strength || 5} -> queued`;
        break;
      }
      case 'heat': {
        cmd = { heat: args.on !== false };
        resultText = `Heat ${args.on !== false ? 'on' : 'off'} -> queued`;
        break;
      }
      case 'stop': {
        // 丢弃尚未执行的旧动作，让手机下一次轮询首先拿到急停。
        commandQueue = [];
        cmd = { stop: true };
        resultText = 'Stop -> queued with priority';
        break;
      }
      case 'pattern': {
        const steps = args.steps || [];
        for (const step of steps) {
          const speed = (step.strength || 5) / 10;
          commandQueue.push({ speed, sec: step.duration || 1 });
        }
        commandQueue.push({ stop: true });
        resultText = `Pattern ${steps.length} steps -> queued`;
        cmd = null; // already pushed
        break;
      }
      case 'vibrate_pattern': {
        cmd = { cmd_type: 'vibrate', mode: args.mode || 1, level: args.level || 3 };
        resultText = `Vibrate pattern mode=${args.mode || 1} level=${args.level || 3} -> queued`;
        break;
      }
      case 'thrust_cmd': {
        cmd = { cmd_type: 'thrust', mode: args.mode || 1, strength: args.strength || 5 };
        resultText = `Thrust cmd mode=${args.mode || 1} strength=${args.strength || 5} -> queued`;
        break;
      }
      case 'suck_cmd': {
        cmd = { cmd_type: 'suck', mode: args.mode || 1, strength: args.strength || 5 };
        resultText = `Suck cmd mode=${args.mode || 1} strength=${args.strength || 5} -> queued`;
        break;
      }
      case 'status': {
        const online = bridgeOnline && (Date.now() - lastPoll < 10000);
        resultText = `Bridge online: ${online}, Queue: ${commandQueue.length}`;
        cmd = null;
        break;
      }
      default:
        return res.json({
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` }
        });
    }

    if (cmd) commandQueue.push(cmd);

    return res.json({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: resultText }]
      }
    });
  }

  // Unknown method
  res.json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
});

// --- 启动 ---
app.listen(PORT, () => {
  console.log(`SVAKOM Bridge Server running on port ${PORT}`);
  console.log(`Secret: ${SECRET ? '***' : '(none)'}`);
  console.log();
  console.log('Endpoints:');
  console.log('  GET  / or /toy - Android Chrome Web Bluetooth bridge');
  console.log('  GET  /toy-next  - phone page / bridge.py polls this');
  console.log('  GET  /status    - check bridge status');
  console.log('  POST /command   - push a command');
  console.log('  POST /mcp       - MCP protocol (for AI clients)');
});
