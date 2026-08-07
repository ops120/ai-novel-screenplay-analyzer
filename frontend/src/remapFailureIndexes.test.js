// v26.3: remapFailureIndexes 单元测试。验证 chunkSize 改变时旧失败切片索引到新坐标的偏移重算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { remapFailureIndexes } from './taskManager.js';

test('同 chunkSize：索引集保持不变', () => {
  assert.deepEqual(
    remapFailureIndexes([0, 1, 2, 3], 1000, 1000),
    [0, 1, 2, 3],
  );
});

test('newChunkSize < old（切片变大）：多个旧切片合并到少数新索引', () => {
  // old=500, new=1000: 旧 [0,1] 覆盖 [0,500)+[500,1000) = [0,1000)，合并成新 0
  assert.deepEqual(
    remapFailureIndexes([0, 1], 500, 1000),
    [0],
  );
  // old=500, new=1500: 旧 [0,1,2] 覆盖 [0,1500)，合并成新 0
  assert.deepEqual(
    remapFailureIndexes([0, 1, 2], 500, 1500),
    [0],
  );
});

test('newChunkSize > old（切片变小）：每个旧切片展开成多个新索引', () => {
  // old=1000, new=500: 旧 0 覆盖 [0,1000)，新 0=[0,500) 新 1=[500,1000)
  assert.deepEqual(
    remapFailureIndexes([0], 1000, 500),
    [0, 1],
  );
  // old=1000, new=300: 旧 0 覆盖 [0,1000)，对应新 0,1,2,3
  assert.deepEqual(
    remapFailureIndexes([0], 1000, 300),
    [0, 1, 2, 3],
  );
  // old=2000, new=500: 旧 0=[0,2000) 对应新 0,1,2,3
  assert.deepEqual(
    remapFailureIndexes([0], 2000, 500),
    [0, 1, 2, 3],
  );
});

test('newChunkSize = old/2（半切片）：每个旧切片展开成 2 个', () => {
  assert.deepEqual(
    remapFailureIndexes([0, 1, 2], 1000, 500),
    [0, 1, 2, 3, 4, 5],
  );
});

test('空数组：返回空数组', () => {
  assert.deepEqual(remapFailureIndexes([], 1000, 500), []);
});

test('非法 oldChunkSize（<=0 或 NaN）：返回空数组', () => {
  assert.deepEqual(remapFailureIndexes([0, 1], 0, 500), []);
  assert.deepEqual(remapFailureIndexes([0, 1], -100, 500), []);
  assert.deepEqual(remapFailureIndexes([0, 1], NaN, 500), []);
  assert.deepEqual(remapFailureIndexes([0, 1], Infinity, 500), []);
});

test('非法 newChunkSize：返回空数组', () => {
  assert.deepEqual(remapFailureIndexes([0, 1], 1000, 0), []);
  assert.deepEqual(remapFailureIndexes([0, 1], 1000, -100), []);
  assert.deepEqual(remapFailureIndexes([0, 1], 1000, NaN), []);
});

test('非法 oldIndexes（非数组）：返回空数组', () => {
  assert.deepEqual(remapFailureIndexes(null, 1000, 500), []);
  assert.deepEqual(remapFailureIndexes(undefined, 1000, 500), []);
  assert.deepEqual(remapFailureIndexes(0, 1000, 500), []);
});

test('跳过非法索引（负数、NaN、字符串）', () => {
  assert.deepEqual(
    remapFailureIndexes([0, -1, NaN, Infinity, 1, 'bad', null], 1000, 500),
    [0, 1, 2, 3],
  );
});

test('输出按升序去重', () => {
  // old=500, new=1000: 旧 [0,1,2,3,4] 全覆盖 [0,2500)，合并去重 -> [0,1,2]
  assert.deepEqual(
    remapFailureIndexes([0, 1, 2, 3, 4], 500, 1000),
    [0, 1, 2],
  );
  // old=500, new=2000: 旧 [0,1,2,3] 全覆盖 [0,2000)，合并成新 0
  assert.deepEqual(
    remapFailureIndexes([0, 1, 2, 3], 500, 2000),
    [0],
  );
});

test('边界：旧切片 0 起始偏移', () => {
  // old=2000, new=1000: 旧 0 覆盖 [0,2000)，新 0=[0,1000), 1=[1000,2000)
  assert.deepEqual(
    remapFailureIndexes([0], 2000, 1000),
    [0, 1],
  );
});

test('边界：newChunkSize 极大，旧索引全合并到 0', () => {
  assert.deepEqual(
    remapFailureIndexes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 10000),
    [0],
  );
});
