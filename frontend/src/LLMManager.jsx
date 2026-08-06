import React, { useState } from 'react';
import { useStore } from './store';

const PROTOCOLS = [
  { value: 'openai', label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1' },
  { value: 'volcano', label: '火山方舟', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { value: 'bailian', label: '阿里百炼', defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }
];

// v2.4：颜色 token 映射 — 把硬编码色值改成 var(--*) 引用，自动跟随主题
// 品牌紫渐变（#667eea → #764ba2）保留为 LLM 主题色，不与全局 accent 混用
const C = {
  surface: 'var(--surface)',
  surface2: 'var(--surface-2)',
  line: 'var(--line)',
  lineSoft: 'var(--line-soft)',
  ink: 'var(--ink)',
  inkSoft: 'var(--ink-soft)',
  inkFaint: 'var(--ink-faint)',
  ok: 'var(--ok, #2f7a48)',
  danger: '#dc2626',
  warning: '#d97706',
  scrim: 'rgba(20, 28, 45, 0.18)',
};

export default function LLMManager({ onClose }) {
  const s = useStore();
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    protocol: 'openai',
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    model_id: '',
    is_default: false
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const handleProtocolChange = (protocol) => {
    const p = PROTOCOLS.find(x => x.value === protocol);
    setFormData({ ...formData, protocol, base_url: p?.defaultUrl || '' });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await s.testLlmModel({
      api_key: formData.api_key,
      base_url: formData.base_url,
      model_id: formData.model_id,
      protocol: formData.protocol
    });
    setTestResult(result);
    setTesting(false);
  };

  const handleSave = async () => {
    if (!formData.name || !formData.api_key || !formData.model_id) {
      alert('请填写完整信息');
      return;
    }

    if (editingId) {
      await s.updateLlmModel(editingId, formData);
    } else {
      await s.addLlmModel(formData);
    }

    resetForm();
  };

  const handleEdit = (model) => {
    setEditingId(model.id);
    setFormData({
      name: model.name,
      protocol: model.protocol,
      api_key: model.api_key,
      base_url: model.base_url,
      model_id: model.model_id,
      is_default: model.is_default === 1
    });
    setTestResult(null);
  };

  const handleDelete = async (id) => {
    if (confirm('确定删除此模型配置？')) {
      await s.deleteLlmModel(id);
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setFormData({
      name: '',
      protocol: 'openai',
      api_key: '',
      base_url: 'https://api.openai.com/v1',
      model_id: '',
      is_default: false
    });
    setTestResult(null);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: C.scrim,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'flex-end',
        zIndex: 100,
        animation: 'nl-fade-in 0.2s ease-out'
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="演化法阵管理"
        style={{
          background: C.surface,
          borderRadius: '16px 0 0 16px',
          width: 520,
          maxWidth: '92vw',
          height: '100vh',
          overflow: 'hidden',
          boxShadow: '-12px 0 36px rgba(15, 23, 42, 0.10)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'nl-slide-in-right 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)'
        }}
      >
        {/* 标题栏 */}
        <div style={{
          padding: '18px 24px',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          color: '#fff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🔮 演化法阵管理</h3>
          <button
            onClick={onClose}
            aria-label="关闭演化法阵"
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              color: '#fff',
              fontSize: 22,
              cursor: 'pointer',
              width: 32,
              height: 32,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s'
            }}
            onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.35)'}
            onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
          >
            ×
          </button>
        </div>

        {/* 内容区 */}
        <div style={{ padding: '20px 24px 24px', overflowY: 'auto', flex: 1 }}>
          {/* 表单区 */}
          <div style={{ background: C.surface2, padding: 24, borderRadius: 12, marginBottom: 24, border: `1px solid ${C.line}` }}>
            <h4 style={{ marginTop: 0, marginBottom: 20, fontSize: 16, fontWeight: 600, color: C.ink }}>
              {editingId ? '✏️ 编辑模型' : '➕ 添加新模型'}
            </h4>
            <div style={{ display: 'grid', gap: 16 }}>
              <input 
                placeholder="模型名称（如：通义千问-Plus）" 
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                style={inputStyle}
              />
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <select 
                  value={formData.protocol}
                  onChange={e => handleProtocolChange(e.target.value)}
                  style={inputStyle}
                >
                  {PROTOCOLS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                
                <input 
                  placeholder="Model ID（如：qwen-plus）" 
                  value={formData.model_id}
                  onChange={e => setFormData({...formData, model_id: e.target.value})}
                  style={inputStyle}
                />
              </div>

              <input 
                placeholder="Base URL" 
                value={formData.base_url}
                onChange={e => setFormData({...formData, base_url: e.target.value})}
                style={inputStyle}
              />

              <input 
                type="password"
                placeholder="API Key" 
                value={formData.api_key}
                onChange={e => setFormData({...formData, api_key: e.target.value})}
                style={inputStyle}
              />

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.inkSoft, cursor: 'pointer' }}>
                <input 
                  type="checkbox"
                  checked={formData.is_default}
                  onChange={e => setFormData({...formData, is_default: e.target.checked})}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                设为默认模型
              </label>

              {testResult && (
                <div style={{ 
                  padding: 12, 
                  borderRadius: 8, 
                  background: testResult.status === 'success' ? C.surface2 : C.surface2,
                  border: `1px solid ${testResult.status === 'success' ? C.ok : C.danger}`,
                  color: testResult.status === 'success' ? C.ok : C.danger,
                  fontSize: 13
                }}>
                  {testResult.status === 'success' ? (
                    <>✅ {testResult.message} - 响应: {testResult.response}</>
                  ) : (
                    <>❌ {testResult.message}</>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12 }}>
                <button 
                  onClick={handleTest} 
                  disabled={testing || !formData.api_key || !formData.model_id}
                  style={{
                    ...actionButtonStyle,
                    flex: 1,
                    background: '#1890ff',
                    opacity: (testing || !formData.api_key || !formData.model_id) ? 0.5 : 1
                  }}
                >
                  {testing ? '测试中...' : '🧪 测试连接'}
                </button>
                <button 
                  onClick={handleSave}
                  style={{
                    ...actionButtonStyle,
                    flex: 1,
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                  }}
                >
                  {editingId ? '💾 更新' : '➕ 添加'}
                </button>
                {editingId && (
                  <button
                    onClick={resetForm}
                    style={{
                      ...actionButtonStyle,
                      background: C.inkFaint
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 模型列表 */}
          <div>
            <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 16, fontWeight: 600, color: C.ink }}>
              已配置的模型
            </h4>
            {s.llmModels.length === 0 ? (
              <div style={{
                padding: 40,
                textAlign: 'center',
                color: C.inkFaint,
                background: C.surface2,
                borderRadius: 12,
                border: `2px dashed ${C.line}`
              }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🔮</div>
                <div style={{ fontSize: 14 }}>暂无模型配置，请添加第一个模型</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {s.llmModels.map(m => (
                  <div 
                    key={m.id} 
                    style={{ 
                      border: `1px solid ${C.line}`,
                      borderRadius: 12,
                      padding: 20,
                      background: m.is_default ? `linear-gradient(135deg, ${C.surface2} 0%, ${C.surface2} 100%)` : C.surface,
                      position: 'relative',
                      transition: 'all 0.3s',
                      boxShadow: s.currentLlmId === m.id ? '0 4px 12px rgba(102, 126, 234, 0.2)' : 'none',
                      borderColor: s.currentLlmId === m.id ? '#667eea' : C.line
                    }}
                  >
                    {m.is_default && (
                      <span style={{ 
                        position: 'absolute', 
                        top: 12, 
                        right: 12, 
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        color: '#fff', 
                        padding: '4px 12px', 
                        borderRadius: 12, 
                        fontSize: 12,
                        fontWeight: 600
                      }}>
                        默认
                      </span>
                    )}
                    <div style={{ marginBottom: 12 }}>
                      <strong style={{ fontSize: 16, color: C.ink }}>{m.name}</strong>
                      <span style={{ marginLeft: 12, color: C.inkFaint, fontSize: 13 }}>
                        {PROTOCOLS.find(p => p.value === m.protocol)?.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: C.inkSoft, marginBottom: 16, lineHeight: 1.6 }}>
                      <div>Model: <code style={{ background: C.lineSoft, padding: '2px 6px', borderRadius: 4 }}>{m.model_id}</code></div>
                      <div style={{ marginTop: 4 }}>URL: <code style={{ background: C.lineSoft, padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{m.base_url}</code></div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button 
                        onClick={() => s.selectLlmModel(m.id)}
                        disabled={s.currentLlmId === m.id}
                        style={{ 
                          padding: '8px 16px', 
                          background: s.currentLlmId === m.id ? C.ok : '#667eea',
                          color: '#fff', 
                          border: 'none', 
                          borderRadius: 6, 
                          cursor: s.currentLlmId === m.id ? 'not-allowed' : 'pointer',
                          fontSize: 13,
                          fontWeight: 500,
                          transition: 'all 0.3s'
                        }}
                      >
                        {s.currentLlmId === m.id ? '✓ 已选择' : '选择'}
                      </button>
                      <button 
                        onClick={() => handleEdit(m)}
                        style={modelActionButtonStyle(C.warning)}
                      >
                        编辑
                      </button>
                      <button 
                        onClick={() => handleDelete(m.id)}
                        style={modelActionButtonStyle(C.danger)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 样式定义
const inputStyle = {
  padding: '10px 14px',
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  fontSize: 14,
  outline: 'none',
  transition: 'all 0.3s',
  fontFamily: 'inherit'
};

const actionButtonStyle = {
  padding: '12px 20px',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
  transition: 'all 0.3s'
};

const modelActionButtonStyle = (color) => ({
  padding: '8px 16px',
  background: color,
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  transition: 'all 0.3s'
});
