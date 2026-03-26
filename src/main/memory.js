const path = require('path');
const { app } = require('electron');
const { LocalIndex } = require('vectra');

const isDev = !app.isPackaged;
const MEMORY_DIR = isDev
    ? path.join(__dirname, '../../memory-store')
    : path.join(app.getPath('userData'), 'memory-store');
const MODEL_CACHE_DIR = isDev
    ? path.join(__dirname, '../../model-cache')
    : path.join(process.resourcesPath, 'model-cache');
const MAX_RESULTS = 3;

let extractor = null;
let index = null;
let initPromise = null;

async function getExtractor() {
    if (extractor) return extractor;
    const { pipeline, env } = await import('@xenova/transformers');

    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = MODEL_CACHE_DIR + '/';
    env.useBrowserCache = false;
    env.useCustomCache = true;

    extractor = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', {
        quantized: true,
    });
    return extractor;
}

// 应用启动时预热，避免首次对话卡顿
function warmup() {
    if (initPromise) return initPromise;
    initPromise = getExtractor().catch((e) => {
        console.warn('Embedding 模型预热失败（记忆功能不可用）:', e.message);
        initPromise = null;
    });
    return initPromise;
}

async function getIndex() {
    if (index) return index;
    index = new LocalIndex(MEMORY_DIR);
    if (!(await index.isIndexCreated())) {
        await index.createIndex();
    }
    return index;
}

async function getEmbedding(text) {
    const ext = await getExtractor();
    const output = await ext(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

async function remember(userText, assistantText) {
    try {
        const content = `用户：${userText}\n助手：${assistantText}`;
        const vector = await getEmbedding(content);
        const idx = await getIndex();
        await idx.insertItem({ vector, metadata: { content, time: Date.now() } });
    } catch (e) {
        console.error('记忆存储失败:', e.message);
    }
}

async function recall(query) {
    try {
        const idx = await getIndex();
        if (!(await idx.isIndexCreated())) return [];
        const vector = await getEmbedding(query);
        const results = await idx.queryItems(vector, MAX_RESULTS);
        return results.filter((r) => r.score > 0.5).map((r) => r.item.metadata.content);
    } catch (e) {
        console.error('记忆检索失败:', e.message);
        return [];
    }
}

async function clearMemory() {
    try {
        const idx = await getIndex();
        if (await idx.isIndexCreated()) {
            await idx.deleteIndex();
            await idx.createIndex();
        }
    } catch (e) {
        console.error('清空记忆失败:', e.message);
    }
}

module.exports = { remember, recall, clearMemory, warmup };
