// 小说剧本智能分析工作台配置文件

// v22.1：API_BASE 集中管理，走 Vite proxy / 生产 nginx
export const API_BASE = '/api';

export const CONFIG = {
  // Debug 模式
  debug: false,
  
  // 默认切片大小
  defaultChunkSize: 500,
  
  // 系统提示词
  systemPrompt: `你是一个专业的小说关系分析提取器。请提取 nodes 和 edges。
必须严格返回合法的 JSON 格式，不要包含任何 markdown 代码块标记。格式要求如下：
{
  "nodes": [{"id": "唯一ID", "label": "人物姓名", "sect": "所属门派"}],
  "edges": [{"source": "人物A的ID", "target": "人物B的ID", "label": "关系描述"}]
}

重要规则：
1. id 命名规则（必须严格遵守）：
   - 使用小写拼音，不要下划线，不要大写
   - 多字姓名直接连写，例如：
     * "张三" → "zhangsan"（正确）
     * "Zhang_San" 或 "ZhangSan" → 错误
     * "李四" → "lisi"（正确）
     * "韩立" → "hanli"（正确）
     * "吕一航" → "lvyihang"（正确）
     * "lv_yi_hang" 或 "luyiHang" → 错误
   - 同一个人物在所有文本片段中必须使用完全相同的 id
2. label 是人物的中文姓名，必须准确
3. sect 是人物所属的门派、组织或势力，如果没有明确信息填"无"
4. edges 中的 source 和 target 必须对应 nodes 中的 id
5. 关系描述要准确反映当前文本中的关系状态
   - 如果关系发生变化，提取最新的关系
   - 系统会自动合并历史关系，形成"同学 → 恋人 → 夫妻"这样的演变链
6. 关系类型示例：同学、朋友、恋人、夫妻、离婚、师徒、道侣、仇敌、盟友等
7. 只返回 JSON，不要有任何其他文字说明
8. 如果文本中出现已知人物，必须使用相同的 id，不要创建重复节点

特别注意：id 的一致性非常重要！请确保同一人物始终使用相同的拼音 id。`,

  // API 配置
  apiConfig: {
    timeout: 60000, // 请求超时时间（毫秒）
    retryCount: 2,  // 失败重试次数
  },
  
  // UI 配置
  ui: {
    defaultLeftWidth: 240,
    defaultMiddleWidth: 360,
    minLeftWidth: 150,
    maxLeftWidth: 400,
    minMiddleWidth: 200,
    maxMiddleWidth: 800,
  }
};

// 从 localStorage 加载配置
export function loadConfig() {
  const saved = localStorage.getItem('storymap_config');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return { ...CONFIG, ...parsed };
    } catch (e) {
      console.error('加载配置失败:', e);
    }
  }
  return CONFIG;
}

// 保存配置到 localStorage
export function saveConfig(config) {
  try {
    localStorage.setItem('storymap_config', JSON.stringify(config));
    return true;
  } catch (e) {
    console.error('保存配置失败:', e);
    return false;
  }
}

// 重置为默认配置
export function resetConfig() {
  localStorage.removeItem('storymap_config');
  return CONFIG;
}
