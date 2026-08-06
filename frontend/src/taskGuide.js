// v25：任务面板「引导模式」的纯状态计算。
//
// 任务列表真正为空时（既没有在跑的任务，也没有可恢复的断点），抽屉不再只显示
// 一句「暂无炼化任务」，而是给出四步可操作清单，并指向第一个未完成的步骤。
//
// 这里只做决策，不碰 DOM：谁是当前步、主按钮该显示什么文案、该跳到哪个控件。
// 真正的滚动与聚焦由 App.jsx 持有 ref 执行 —— 保证本模块可在 node 下纯测。

// 四步固定顺序；id 同时是 App.jsx 里 ref 的跳转目标 key。
const STEP_DEFS = [
  { id: 'project', title: '选择或创建项目', actionLabel: '选择或创建项目' },
  { id: 'text', title: '导入或粘贴文本', actionLabel: '导入或粘贴文本' },
  { id: 'model', title: '选择模型', actionLabel: '选择模型' },
  { id: 'analyze', title: '开始分析', actionLabel: '准备开始分析' },
];

/**
 * @param {object} state
 *   - hasProject: boolean  已选中/已创建项目
 *   - hasText:    boolean  已有非空原文
 *   - hasModel:   boolean  已选中 LLM 模型
 * @returns {{steps: Array<{id,title,state}>, target: string, actionLabel: string}}
 *   steps[].state ∈ 'done' | 'current' | 'pending'
 *   target        第一个未完成步骤的 id；三步都完成时为 'analyze'
 */
export function buildTaskGuide(state = {}) {
  const done = [
    Boolean(state.hasProject),
    Boolean(state.hasText),
    Boolean(state.hasModel),
    // 第四步「开始分析」是终点动作，前三步齐备时它才成为 current，且永不为 done。
    false,
  ];

  const currentIndex = done.findIndex((isDone) => !isDone);

  const steps = STEP_DEFS.map((def, index) => {
    let stepState = 'pending';
    if (index < currentIndex) stepState = 'done';
    else if (index === currentIndex) stepState = 'current';
    return { id: def.id, title: def.title, state: stepState };
  });

  const current = STEP_DEFS[currentIndex];
  return {
    steps,
    target: current.id,
    actionLabel: current.actionLabel,
  };
}

// 恢复项没有项目名时的占位文案。
const FALLBACK_PROJECT_NAME = '未命名项目';

/**
 * v25：解析任务行该显示的项目名。
 *
 * progressStore 按 projectId 分组存储，而 projectId 是对象键 —— 取回来一律是**字符串**；
 * 项目列表里的 id 来自后端 SQLite，是**数字**。所以反查必须两边都转成字符串，
 * 否则恢复项永远匹配不上、永远显示占位文案。
 *
 * @param {{projectId: string|number, projectName?: string}} task
 * @param {Array<{id: string|number, name?: string}>} projects
 * @returns {string}
 */
export function resolveTaskProjectName(task, projects) {
  if (!task) return FALLBACK_PROJECT_NAME;

  // 任务自带名字（真实任务创建时由 store 传入）时优先使用。
  const own = typeof task.projectName === 'string' ? task.projectName.trim() : '';
  if (own) return own;

  if (Array.isArray(projects) && task.projectId != null) {
    const key = String(task.projectId);
    const hit = projects.find((p) => p && p.id != null && String(p.id) === key);
    const name = typeof hit?.name === 'string' ? hit.name.trim() : '';
    if (name) return name;
  }

  return FALLBACK_PROJECT_NAME;
}
