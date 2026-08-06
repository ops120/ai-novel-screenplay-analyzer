// Electron 预加载脚本
// 在渲染进程加载前执行，通过 contextBridge 安全暴露 API

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => process.versions.electron,
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});

// 版本信息写入 DOM（兼容旧页面元素）
window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});
