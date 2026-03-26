let app = null;
let model = null;
let messages = [];
let bubbleTimer = null;
let isSending = false;
let chatIdleTimer = null; // 对话框自动收起计时器

// ── 窗口拖拽（移动整个窗口）──────────────────────────────────────────────────
let dragState = null; // { startX, startY, moved }

document.addEventListener('mousedown', (e) => {
    // 如果点在输入框、发送按钮或气泡上，不触发拖拽
    if (e.target.closest('#chat-area') || e.target.closest('#bubble')) return;
    dragState = { startX: e.screenX, startY: e.screenY, moved: false };
});

document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.screenX - dragState.startX;
    const dy = e.screenY - dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        dragState.moved = true;
        dragState.startX = e.screenX;
        dragState.startY = e.screenY;
        window.api.moveWindow(dx, dy);
    }
});

document.addEventListener('mouseup', () => {
    dragState = null;
});

// 右键弹出原生菜单（设置 / 退出）
document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    dragState = null;
    window.api.showContextMenu();
});

// ── Live2D 初始化 ────────────────────────────────────────────────────────────
async function initLive2D() {
    if (typeof PIXI === 'undefined') {
        showBubble('PIXI 库未加载');
        return;
    }

    try {
        app = new PIXI.Application({
            view: document.getElementById('live2d-canvas'),
            width: 300,
            height: 300,
            backgroundAlpha: 0,
            antialias: true,
            autoDensity: true,
            clearBeforeRender: true,
            preserveDrawingBuffer: false,
            premultipliedAlpha: false,
            powerPreference: 'high-performance',
        });

        // 在每帧渲染前（HIGH 优先级）清除画布，确保透明背景干净
        const gl = app.renderer.gl;
        app.ticker.add(
            () => {
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
            },
            null,
            PIXI.UPDATE_PRIORITY.HIGH
        );
    } catch (e) {
        showBubble('PIXI 初始化失败: ' + e.message);
        return;
    }

    const config = await window.api.getConfig();
    const modelPath = config.currentModelUrl;
    if (!modelPath) {
        showBubble('请点击右上角托盘图标 → 设置，选择一个模型');
        return;
    }

    await loadModel(modelPath);
}

async function loadModel(modelPath) {
    if (!app || !app.stage) return;

    if (!PIXI.live2d || !PIXI.live2d.Live2DModel) {
        showBubble('Live2D 库未加载');
        return;
    }

    const { Live2DModel } = PIXI.live2d;

    if (model) {
        app.stage.removeChild(model);
        model.destroy();
        model = null;
    }

    try {
        const url = modelPath;
        model = await Live2DModel.from(url);
        app.stage.addChild(model);

        const config = await window.api.getConfig();
        const modelScale = config.modelScale || 1.0;

        // 根据 scale 计算实际 canvas 尺寸（基准 300px）
        const canvasSize = Math.round(300 * modelScale);
        const bubbleAreaH = Math.round(120 * Math.min(modelScale, 1.2)); // 气泡区适度跟随
        const chatAreaH = 56; // 输入框固定高度
        const windowW = Math.max(300, canvasSize);
        const windowH = bubbleAreaH + canvasSize + chatAreaH;

        // 调整 canvas 元素和 PIXI renderer 尺寸
        const canvas = document.getElementById('live2d-canvas');
        canvas.style.width = canvasSize + 'px';
        canvas.style.height = canvasSize + 'px';
        app.renderer.resize(canvasSize, canvasSize);

        // 调整容器和气泡区尺寸
        document.getElementById('canvas-container').style.width = canvasSize + 'px';
        document.getElementById('canvas-container').style.height = canvasSize + 'px';
        document.getElementById('bubble-area').style.height = bubbleAreaH + 'px';
        document.getElementById('app').style.width = windowW + 'px';

        // 通知主进程调整窗口
        await window.api.resizeWindow(windowW, windowH);

        // 模型缩放和定位（居中底对齐）
        const baseScale = Math.min(canvasSize / model.width, canvasSize / model.height) * 0.85;
        model.scale.set(baseScale);
        model.x = canvasSize / 2;
        model.y = canvasSize - 10;
        model.anchor.set(0.5, 1);

        // 点击 hit area 触发动作（有的模型支持）
        model.on('hit', (hitAreas) => {
            console.log('hit areas:', hitAreas);
            // 禁用模型动画，避免产生渲染残影
            // if (hitAreas.some(a => /head/i.test(a))) {
            //   model.motion('TapHead')
            // } else {
            //   model.motion('TapBody')
            // }
        });

        // 点击画布任意位置显示对话框（兜底，区分拖拽和点击）
        document.getElementById('live2d-canvas').addEventListener('mouseup', () => {
            if (dragState && !dragState.moved) {
                showChatArea();
            }
        });

        showBubble('嗨～来和我对话吧 (◕‿◕)');
    } catch (e) {
        console.error('Live2D 加载失败:', e);
        showBubble('模型加载失败: ' + e.message);
    }
}

// ── 聊天框显示 ───────────────────────────────────────────────────────────────
const CHAT_IDLE_MS = 15000; // 15秒无操作自动收起

function showChatArea() {
    const chatArea = document.getElementById('chat-area');
    chatArea.classList.add('visible');
    document.getElementById('chat-input').focus();
    resetChatIdleTimer();
}

function hideChatArea() {
    if (isSending) return;
    document.getElementById('chat-area').classList.remove('visible');
    clearTimeout(chatIdleTimer);
}

function resetChatIdleTimer() {
    clearTimeout(chatIdleTimer);
    chatIdleTimer = setTimeout(hideChatArea, CHAT_IDLE_MS);
}

// ── 流式发送消息 ─────────────────────────────────────────────────────────────
async function sendMessage() {
    if (isSending) return;
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    isSending = true;
    sendBtn.disabled = true;
    messages.push({ role: 'user', content: text });

    let fullReply = '';
    showBubble('让我想想~', 0);

    // 每次发送前清除旧监听，避免重复触发
    window.api.removeChatListeners();

    const chunkHandler = (chunk) => {
        fullReply += chunk;
        updateBubble(fullReply);
    };
    const doneHandler = () => {
        messages.push({ role: 'assistant', content: fullReply });
        if (messages.length > 20) messages = messages.slice(-20);
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(() => hideBubble(), 6000);
        isSending = false;
        sendBtn.disabled = false;
        input.focus();
    };
    const errorHandler = (err) => {
        updateBubble('出错了：' + err);
        messages.pop();
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(() => hideBubble(), 4000);
        isSending = false;
        sendBtn.disabled = false;
        input.focus();
    };

    window.api.onChatChunk(chunkHandler);
    window.api.onceChatDone(doneHandler);
    window.api.onceChatError(errorHandler);

    await window.api.chatStream(messages);
}

// ── 气泡工具函数 ─────────────────────────────────────────────────────────────
function showBubble(text, duration = 4000) {
    const bubble = document.getElementById('bubble');
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubble.scrollTop = bubble.scrollHeight;
    if (duration > 0) {
        bubbleTimer = setTimeout(() => hideBubble(), duration);
    }
}

function updateBubble(text) {
    const bubble = document.getElementById('bubble');
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubble.scrollTop = bubble.scrollHeight;
}

function hideBubble() {
    const bubble = document.getElementById('bubble');
    bubble.classList.remove('show');
    setTimeout(() => {
        if (!bubble.classList.contains('show')) bubble.textContent = '';
    }, 250);
}

// ── 事件绑定 ─────────────────────────────────────────────────────────────────
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
    resetChatIdleTimer();
    if (e.key === 'Enter') sendMessage();
    if (e.key === 'Escape') {
        hideChatArea();
        hideBubble();
    }
});

window.api.onConfigUpdated(async () => {
    messages = [];
    showBubble('配置已更新！(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧');

    // 重新加载模型以应用新的缩放
    const config = await window.api.getConfig();
    if (config.currentModelUrl && model) {
        await loadModel(config.currentModelUrl);
    }
});

window.api.onModelChanged((modelPath) => {
    showBubble('切换模型中...', 0);
    loadModel(modelPath);
});

initLive2D();
