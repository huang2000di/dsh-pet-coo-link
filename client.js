/**
 * dsh-pet-coo-link — browser half.
 *
 * 只做一件事：在「设置 → 插件」里放一张卡片，用来开关两只桌宠的自动对话。
 * 数据面走宿主端点：
 *   GET  /pet-coo/status          当前状态
 *   POST /pet-coo/toggle {enabled} 开/关
 *
 * 文件是手写的 DSH client module：执行时只注册一个惰性 factory，
 * 真正的副作用都放在 factory 内部，由宿主按需物化。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-coo-link',
  factory(require) {
    const React = require('react')

    const BASE = '/pet-coo'
    const TAB_SLOT = 'settings.plugins.tab'
    const ROW_ID = 'dsh-pet-coo-link'

    const TEXT = {
      tab: '桌宠对话',
      title: '桌宠对话（大肥鱼 × 蓝毛小女仆）',
      intro: '开启后，每隔一段时间让两只桌宠自己聊一轮；关闭即停。',
      enable: '启用自动对话循环',
      interval: '每隔多少分钟聊一轮',
      hotkey: '快捷键',
      hotkeyHint: '单功能键即可，例如 F9、F10；也可用 Control+Alt+P',
      hotkeySave: '保存快捷键',
      intervalSave: '保存间隔',
      memory: '共享记忆',
      last: '最近一句',
      save: '保存',
      saving: '保存中…',
      loading: '读取中…',
      on: '正在聊',
      off: '已停止',
      failed: '操作失败：',
    }

    async function getStatus() {
      const res = await fetch(`${BASE}/status`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function setIntervalMinutes(minutes) {
      const res = await fetch(`${BASE}/interval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minutes }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function setHotkey(hotkey) {
      const res = await fetch(`${BASE}/hotkey`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hotkey }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function setEnabled(enabled) {
      const res = await fetch(`${BASE}/toggle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    function PetCooSettings() {
      const t = TEXT
      const [state, setState] = React.useState({ status: 'loading' })
      const [busy, setBusy] = React.useState(false)
      const [hotkeyDraft, setHotkeyDraft] = React.useState('')
      const [minutesDraft, setMinutesDraft] = React.useState('')

      const refresh = React.useCallback(() => {
        getStatus()
          .then((data) => {
            setState({ status: 'ready', data })
            // 输入框跟着真实值走，避免显示上一次的草稿。
            setMinutesDraft(String(data?.intervalMinutes ?? ''))
            setHotkeyDraft(String(data?.hotkey ?? ''))
          })
          .catch((e) => setState({ status: 'error', error: String(e && e.message ? e.message : e) }))
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      const toggle = async (next) => {
        setBusy(true)
        try {
          const result = await setEnabled(next)
          setState((prev) => ({ ...prev, data: { ...(prev.data ?? {}), enabled: result.enabled === true } }))
          setTimeout(refresh, 1200)
        } catch (e) {
          setState({ status: 'error', error: String(e && e.message ? e.message : e) })
        } finally {
          setBusy(false)
        }
      }

      const style = {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '4px 2px',
        fontSize: 14,
        lineHeight: 1.6,
      }
      const rowStyle = { display: 'flex', alignItems: 'center', gap: 10 }
      const hintStyle = { opacity: 0.65, fontSize: 13 }

      if (state.status === 'loading') return React.createElement('div', { style }, t.loading)
      if (state.status === 'error') {
        return React.createElement('div', { style }, `${t.failed}${state.error}`)
      }

      const data = state.data ?? {}
      const enabled = data.enabled === true

      return React.createElement(
        'div',
        { style },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, t.title),
        React.createElement('div', { style: hintStyle }, t.intro),
        React.createElement(
          'label',
          { style: { ...rowStyle, cursor: busy ? 'default' : 'pointer' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: busy,
            onChange: (e) => toggle(e.target.checked),
          }),
          React.createElement('span', null, t.enable),
          React.createElement('span', { style: hintStyle }, enabled ? `· ${t.on}` : `· ${t.off}`),
        ),
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement('span', null, `${t.interval}：`),
          React.createElement('input', {
            type: 'number',
            min: 0.5,
            max: 240,
            step: 0.5,
            value: minutesDraft,
            disabled: busy,
            onChange: (e) => setMinutesDraft(e.target.value),
            style: {
              width: 90,
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid rgba(128,128,128,.4)',
            },
          }),
          React.createElement('span', { style: hintStyle }, '分钟'),
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy || !Number(minutesDraft) || String(Number(minutesDraft)) === String(data.intervalMinutes ?? ''),
              onClick: async () => {
                setBusy(true)
                try {
                  const saved = await setIntervalMinutes(Number(minutesDraft))
                  setState((prev) => ({ ...prev, data: { ...(prev.data ?? {}), intervalMinutes: saved.intervalMinutes } }))
                } catch (e) {
                  setState({ status: 'error', error: String(e && e.message ? e.message : e) })
                } finally {
                  setBusy(false)
                }
              },
              style: { padding: '4px 10px', borderRadius: 6, cursor: 'pointer' },
            },
            t.intervalSave,
          ),
        ),
        React.createElement(
          'div',
          { style: hintStyle },
          `${t.memory}：${data.memoryLines ?? 0} 轮`,
        ),
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement('span', null, `${t.hotkey}：`),
          React.createElement('input', {
            type: 'text',
            value: hotkeyDraft,
            disabled: busy,
            placeholder: 'F9',
            onChange: (e) => setHotkeyDraft(e.target.value),
            style: {
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid rgba(128,128,128,.4)',
              minWidth: 180,
            },
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy || !hotkeyDraft.trim() || hotkeyDraft.trim() === (data.hotkey ?? ''),
              onClick: async () => {
                setBusy(true)
                try {
                  const saved = await setHotkey(hotkeyDraft.trim())
                  setState((prev) => ({ ...prev, data: { ...(prev.data ?? {}), hotkey: saved.hotkey } }))
                } catch (e) {
                  setState({ status: 'error', error: String(e && e.message ? e.message : e) })
                } finally {
                  setBusy(false)
                }
              },
              style: { padding: '4px 10px', borderRadius: 6, cursor: 'pointer' },
            },
            t.hotkeySave,
          ),
        ),
        React.createElement('div', { style: hintStyle }, t.hotkeyHint),
        data.lastReply
          ? React.createElement('div', { style: hintStyle }, `${t.last}：${String(data.lastReply).slice(0, 80)}`)
          : null,
        React.createElement('div', { style: hintStyle }, busy ? t.saving : ''),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(TAB_SLOT, () =>
          ctx.slots.register(
            { name: TAB_SLOT, id: ROW_ID, order: 120, label: () => TEXT.tab },
            PetCooSettings,
          ),
        )
      },
    }
  },
})