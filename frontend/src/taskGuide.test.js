// v25：任务面板引导模式的纯状态计算单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskGuide, resolveTaskProjectName } from './taskGuide.js';

test('引导跳到第一个未完成步骤', () => {
  assert.equal(buildTaskGuide({ hasProject: false, hasText: false, hasModel: false }).target, 'project');
  assert.equal(buildTaskGuide({ hasProject: true, hasText: false, hasModel: false }).target, 'text');
  assert.equal(buildTaskGuide({ hasProject: true, hasText: true, hasModel: false }).target, 'model');
  assert.equal(buildTaskGuide({ hasProject: true, hasText: true, hasModel: true }).target, 'analyze');
});

test('引导返回四步及完成状态', () => {
  const guide = buildTaskGuide({ hasProject: true, hasText: true, hasModel: false });
  assert.deepEqual(guide.steps.map((step) => step.state), ['done', 'done', 'current', 'pending']);
  assert.equal(guide.actionLabel, '选择模型');
});

// ---- v25：恢复项项目名反查 ----

test('恢复项缺项目名时按 projectId 反查真实名称', () => {
  const projects = [{ id: 7, name: '山海志' }, { id: 8, name: '别卷' }];
  // progressStore 的 projectId 来自对象键，一律是字符串；项目列表里是数字。
  assert.equal(resolveTaskProjectName({ projectId: '7', projectName: '' }, projects), '山海志');
  assert.equal(resolveTaskProjectName({ projectId: 7, projectName: '' }, projects), '山海志');
});

test('任务自带项目名时优先使用，反查不到时回退占位文案', () => {
  const projects = [{ id: 7, name: '山海志' }];
  assert.equal(resolveTaskProjectName({ projectId: '7', projectName: '任务内名字' }, projects), '任务内名字');
  assert.equal(resolveTaskProjectName({ projectId: '99', projectName: '' }, projects), '未命名项目');
  assert.equal(resolveTaskProjectName({ projectId: '7', projectName: '' }, []), '未命名项目');
  assert.equal(resolveTaskProjectName({ projectId: '7', projectName: '' }, undefined), '未命名项目');
});
