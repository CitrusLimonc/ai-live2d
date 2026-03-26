// Electron 内置 Node 版本可能缺少 File 全局对象，需在所有 require 之前补丁
if (typeof File === 'undefined') {
    const { Blob } = require('buffer');
    global.File = class File extends Blob {
        constructor(chunks, name, opts = {}) {
            super(chunks, opts);
            this.name = name;
            this.lastModified = opts.lastModified || Date.now();
        }
    };
}

const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { remember, recall, clearMemory, warmup } = require('./memory');

protocol.registerSchemesAsPrivileged([
    { scheme: 'local', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(() => {
    protocol.handle('local', async (request) => {
        let filePath = decodeURIComponent(request.url.replace('local://', ''));
        if (!filePath.startsWith('/')) filePath = '/' + filePath;
        const data = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.moc3': 'application/octet-stream',
            '.model3.json': 'application/json',
        };
        return new Response(data, {
            headers: { 'content-type': mimeTypes[ext] || 'application/octet-stream' },
        });
    });
    createMainWindow();
    createTray();
    warmup();
});

function getConfigPath() {
    if (app.isPackaged) {
        return path.join(app.getPath('userData'), 'config.json');
    }
    return path.join(__dirname, '../../config/config.json');
}

function ensureConfig() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        const defaultConfig = app.isPackaged
            ? path.join(process.resourcesPath, 'config/config.json')
            : path.join(__dirname, '../../config/config.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.copyFileSync(defaultConfig, configPath);
    }
}

function getBundledModelsDir() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'models');
    }
    return path.join(__dirname, '../../models');
}

function getUserModelsDir() {
    return path.join(app.getPath('userData'), 'models');
}

function resolvePath(modelPath) {
    if (!modelPath) return null;
    if (modelPath.startsWith('bundled://')) {
        return path.join(getBundledModelsDir(), modelPath.slice('bundled://'.length));
    }
    if (modelPath.startsWith('user://')) {
        return path.join(getUserModelsDir(), modelPath.slice('user://'.length));
    }
    return modelPath;
}

function toVirtualPath(absPath) {
    const bundledDir = getBundledModelsDir();
    const userDir = getUserModelsDir();
    if (absPath.startsWith(bundledDir)) {
        return 'bundled://' + absPath.slice(bundledDir.length + 1);
    }
    if (absPath.startsWith(userDir)) {
        return 'user://' + absPath.slice(userDir.length + 1);
    }
    return absPath;
}

let mainWindow;
let settingsWindow;
let tray;

function loadConfig() {
    ensureConfig();
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
}

function saveConfig(config) {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function scanDir(dir, prefix) {
    if (!fs.existsSync(dir)) return [];
    const results = [];
    for (const name of fs.readdirSync(dir)) {
        const fullDir = path.join(dir, name);
        if (!fs.statSync(fullDir).isDirectory()) continue;
        const model3 = fs.readdirSync(fullDir).find((f) => f.endsWith('.model3.json'));
        if (model3) results.push({ name, path: prefix + name + '/' + model3 });
    }
    return results;
}

function scanModels() {
    const bundled = scanDir(getBundledModelsDir(), 'bundled://');
    const user = scanDir(getUserModelsDir(), 'user://');
    return [...bundled, ...user];
}

function copyModelDir(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
        const s = path.join(srcDir, file);
        const d = path.join(destDir, file);
        if (fs.statSync(s).isDirectory()) {
            fs.mkdirSync(d, { recursive: true });
            for (const sub of fs.readdirSync(s)) {
                fs.copyFileSync(path.join(s, sub), path.join(d, sub));
            }
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

function createMainWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: 300,
        height: 570,
        x: width - 320,
        y: height - 590,
        transparent: true,
        frame: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self' 'unsafe-inline' 'unsafe-eval' file: local: data: blob:",
                ],
            },
        });
    });
}

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 520,
        height: 620,
        title: '设置',
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function createTray() {
    const iconData =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABzSURBVDiNY2AYBaNgFIyCYQEMDAwM/6HgPxQzYBMgxgAWbAqINQCbZmINwKYZmwHYNGMzAJtmbAZg04zNAGyasRmATTM2A7BpxmYANs3YDMCmGZsB2DRjMwCbZmwGYNOMzQBsmrEZgE0zNgOwaR4FgwEAAKm6EwVqmVsAAAAASUVORK5CYII=';
    const icon = nativeImage.createFromDataURL(iconData);

    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: '设置', click: () => createSettingsWindow() },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
    ]);

    tray.setToolTip('AI Live2D');
    tray.setContextMenu(contextMenu);
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', () => {
    const config = loadConfig();
    if (config.currentModel) {
        config.currentModelUrl = 'local://' + resolvePath(config.currentModel);
    }
    return config;
});

ipcMain.handle('save-config', (_, config) => {
    // 如果 currentModel 是 local:// 格式，需要转回虚拟路径
    if (config.currentModel && config.currentModel.startsWith('local://')) {
        const absPath = config.currentModel.replace('local://', '');
        config.currentModel = toVirtualPath(absPath);
    }
    saveConfig(config);
    if (mainWindow) mainWindow.webContents.send('config-updated', config);
    return true;
});

ipcMain.handle('open-settings', () => createSettingsWindow());

ipcMain.handle('delete-model', (_, virtualPath) => {
    // 只允许删除用户导入的模型，内置模型不可删除
    if (!virtualPath.startsWith('user://')) {
        return { error: '内置模型不可删除' };
    }
    const absPath = resolvePath(virtualPath);
    const modelDir = path.dirname(absPath);
    if (!fs.existsSync(modelDir)) return { error: '模型目录不存在' };
    fs.rmSync(modelDir, { recursive: true, force: true });
    // 如果删除的是当前模型，清空 config
    const config = loadConfig();
    if (config.currentModel === virtualPath) {
        config.currentModel = '';
        saveConfig(config);
    }
    return { success: true };
});

ipcMain.handle('scan-models', () => scanModels());

ipcMain.handle('import-model', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择 model3.json 文件',
        filters: [{ name: 'Live2D Model', extensions: ['json'] }],
        properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;

    const modelFile = filePaths[0];
    if (!modelFile.endsWith('.model3.json')) return { error: '请选择 .model3.json 文件' };

    const srcDir = path.dirname(modelFile);
    const modelName = path.basename(modelFile).replace('.model3.json', '');
    const userModelsDir = getUserModelsDir();
    const destDir = path.join(userModelsDir, modelName);

    if (fs.existsSync(destDir)) return { error: `模型 "${modelName}" 已存在` };

    copyModelDir(srcDir, destDir);
    const model3Name = path.basename(modelFile);
    const virtualPath = 'user://' + modelName + '/' + model3Name;
    return { name: modelName, path: virtualPath };
});

ipcMain.handle('switch-model', (_, modelPath) => {
    const config = loadConfig();
    config.currentModel = modelPath;
    saveConfig(config);
    const absPath = resolvePath(modelPath);
    if (mainWindow) mainWindow.webContents.send('model-changed', 'local://' + absPath);
    return true;
});

ipcMain.handle('chat-stream', async (event, messages) => {
    const { default: OpenAI } = require('openai');
    const config = loadConfig();

    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
    });

    try {
        // 取最新一条用户消息，检索相关历史记忆
        const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
        const memories = lastUserMsg ? await recall(lastUserMsg.content) : [];

        // 构造含记忆的 system prompt
        let systemContent = config.systemPrompt;
        if (memories.length > 0) {
            systemContent += '\n\n你还记得以前的一些对话：\n' + memories.map((m) => `- ${m}`).join('\n');
        }

        const requestParams = {
            model: config.model,
            messages: [{ role: 'system', content: systemContent }, ...messages],
            max_tokens: 8000,
            stream: true,
        };

        // 通义千问启用联网搜索
        if (config.baseURL && config.baseURL.includes('dashscope.aliyuncs.com')) {
            requestParams.enable_search = true;
        }

        // DeepSeek 启用联网搜索
        if (config.baseURL && config.baseURL.includes('deepseek.com')) {
            requestParams.enable_web_search = true;
        }

        const stream = await client.chat.completions.create(requestParams);

        let fullReply = '';
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                fullReply += content;
                event.sender.send('chat-chunk', content);
            }
        }

        // 对话结束后存入记忆
        if (lastUserMsg && fullReply) {
            remember(lastUserMsg.content, fullReply).catch(() => {});
        }

        event.sender.send('chat-done');
        return true;
    } catch (error) {
        event.sender.send('chat-error', error.message);
        return false;
    }
});

ipcMain.on('show-context-menu', (event) => {
    const menu = Menu.buildFromTemplate([
        { label: '设置', click: () => createSettingsWindow() },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
    ]);
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

ipcMain.handle('move-window', (_, deltaX, deltaY) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + deltaX, y + deltaY);
});

ipcMain.handle('resize-window', (_, width, height) => {
    if (!mainWindow) return;
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setSize(width, height);
    mainWindow.setPosition(screenWidth - width - 20, screenHeight - height - 20);
});

ipcMain.handle('clear-memory', async () => {
    await clearMemory();
    return true;
});
