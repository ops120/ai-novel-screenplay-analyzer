const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const {
  getPersistentDatabasePath,
  getLegacyDatabaseCandidates,
  migrateLegacyDatabase,
  buildBackendEnv,
  focusMainWindow
} = require('./databasePersistence');

// IPC: 打开外部链接
ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    await shell.openExternal(url);
  }
});

let mainWindow;
let backendProcess;
const BACKEND_PORT = 28000;

// 获取资源路径
function getResourcePath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, relativePath);
}

// 检查端口是否可用
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    
    server.once('error', () => {
      resolve(false);
    });
    
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    
    server.listen(port);
  });
}

// 启动后端服务
async function startBackend() {
  console.log('正在启动后端服务...');
  
  // 检查端口
  const portAvailable = await isPortAvailable(BACKEND_PORT);
  if (!portAvailable) {
    dialog.showErrorBox(
      '端口被占用',
      `端口 ${BACKEND_PORT} 已被占用，请关闭占用该端口的程序后重试。`
    );
    app.quit();
    return false;
  }

  const backendPath = getResourcePath('backend/storymap-backend.exe');
  
  if (!fs.existsSync(backendPath)) {
    console.error('后端可执行文件不存在:', backendPath);
    dialog.showErrorBox(
      '启动失败',
      '找不到后端服务文件，请重新安装应用。'
    );
    app.quit();
    return false;
  }

  const targetDb = getPersistentDatabasePath(app.getPath('userData'));
  const legacyCandidates = getLegacyDatabaseCandidates({
    backendPath,
    isPackaged: app.isPackaged,
    developmentDatabasePath: app.isPackaged
      ? undefined
      : path.resolve(__dirname, '..', 'storymap.db'),
    // productName 改名后 userData 目录会变化，保留旧目录中的数据库迁移入口。
    legacyUserDataDatabasePath: path.join(
      app.getPath('appData'),
      '众生谱',
      'storymap.db'
    )
  });

  try {
    const migration = migrateLegacyDatabase({ targetDb, legacyCandidates });
    console.log('数据库持久化状态:', {
      status: migration.status,
      source: migration.source,
      target: migration.target
    });
  } catch (error) {
    console.error('数据库迁移失败:', error);
    dialog.showErrorBox(
      '数据库迁移失败',
      `无法准备数据库文件: ${error.message}`
    );
    return false;
  }

  try {
    backendProcess = spawn(backendPath, [], {
      cwd: path.dirname(backendPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildBackendEnv(process.env, targetDb)
    });

    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data.toString()}`);
    });

    backendProcess.stderr.on('data', (data) => {
      console.error(`[Backend Error] ${data.toString()}`);
    });

    backendProcess.on('error', (error) => {
      console.error('后端进程启动失败:', error);
      dialog.showErrorBox(
        '启动失败',
        `后端服务启动失败: ${error.message}`
      );
    });

    backendProcess.on('exit', (code, signal) => {
      console.log(`后端进程退出: code=${code}, signal=${signal}`);
      if (code !== 0 && code !== null) {
        dialog.showErrorBox(
          '服务异常',
          `后端服务异常退出，错误代码: ${code}`
        );
      }
    });

    // 等待后端启动
    console.log('等待后端服务启动...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 验证后端是否启动成功
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/`, (res) => {
        console.log('后端服务启动成功');
        resolve(true);
      });
      
      req.on('error', () => {
        console.error('后端服务启动失败');
        dialog.showErrorBox(
          '启动失败',
          '后端服务启动失败，请检查日志或重新安装。'
        );
        resolve(false);
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch (error) {
    console.error('启动后端时出错:', error);
    return false;
  }
}

// 创建主窗口
async function createWindow() {
  // 显示启动画面（可选）
  console.log('正在初始化应用...');

  // 启动后端
  const backendStarted = await startBackend();
  if (!backendStarted) {
    app.quit();
    return;
  }

  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    show: false // 先不显示，等加载完成
  });

  // 加载前端页面
  const frontendPath = getResourcePath('frontend/index.html');
  
  if (fs.existsSync(frontendPath)) {
    await mainWindow.loadFile(frontendPath);
  } else {
    console.error('前端文件不存在:', frontendPath);
    dialog.showErrorBox(
      '启动失败',
      '找不到前端文件，请重新安装应用。'
    );
    app.quit();
    return;
  }

  // 页面加载完成后显示窗口
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    console.log('应用启动完成');
  });

  // 开发模式下打开开发者工具
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 拦截新窗口打开
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      focusMainWindow(mainWindow);
    }
  });

  // 应用准备就绪
  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

// 所有窗口关闭
app.on('window-all-closed', () => {
  // 关闭后端进程
  if (backendProcess && !backendProcess.killed) {
    console.log('正在关闭后端服务...');
    backendProcess.kill('SIGTERM');
    
    // 如果 3 秒后还没关闭，强制结束
    setTimeout(() => {
      if (backendProcess && !backendProcess.killed) {
        console.log('强制关闭后端服务');
        backendProcess.kill('SIGKILL');
      }
    }, 3000);
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前
app.on('before-quit', () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill('SIGTERM');
  }
});

// 捕获未处理的异常
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  dialog.showErrorBox(
    '应用错误',
    `发生未预期的错误: ${error.message}`
  );
});
