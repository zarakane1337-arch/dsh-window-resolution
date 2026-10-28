/**
 * dsh-plugin-resolution — 浏览器半边（Client half）。
 *
 * 由 DSH 的客户端模块加载器执行：这里没有 ESM 语法，唯一的依赖是宿主提供的
 * `react`。整份文件只做一件事 —— 在设置页注册一个 `settings.section` 分区，
 * 渲染标题与一行说明。
 *
 * ## 约束（T01 骨架）
 *
 * - **无副作用**：不改 app root、不碰别人的 DOM、不注册任何 `ctx.effect` 或全局事件；
 *   唯一的两次 `ctx` 调用（`locale.register` / `slots.inject`）都是注册声明，由
 *   DSH 自己持有生命周期，插件侧没有需要清理的资源。
 * - **静默降级**：上下文缺服务、插槽还没就绪、locale 服务不可用，都只是少一块 UI，
 *   绝不抛错 —— 抛错会让整个设置页挂掉。
 * - 文案与 `locale/zh-CN.json`、`locale/en.json` 逐字一致（由 `test/locale.test.js`
 *   对拍）。客户端不能直接读取那两个 JSON：加载器只负责提供 `react` 等宿主依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-resolution',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /** 客户端 locale 命名空间，与插件 id 一致。 */
    var NS = 'dsh-plugin-resolution'

    /** 分区在设置页里的稳定 id（升级时不换 id，避免用户的自定义顺序丢失）。 */
    var SECTION_ID = 'window-resolution'

    /** 分区排序：通用设置（60）之后、插件管理之前。 */
    var SECTION_ORDER = 80

    var ZH = {
      section: '窗口分辨率',
      sectionDescription: '选择主窗口的外框尺寸，改完立即生效，并在每次启动 DSH 时强制应用。',
      statusDesktop: '已检测到 DSH 桌面端。',
      statusNotDesktop: '当前不在 DSH 桌面端运行，窗口尺寸无法在这里调整。',
      statusPatched: '窗口通道已就绪。',
      statusNotPatched: '窗口通道尚未注入；注入完成后需要重启 DSH 两次才会生效。',
      statusError: '上次操作失败：{message}',
    }

    var EN = {
      section: 'Window Resolution',
      sectionDescription:
        'Choose the outer size of the DSH main window. Changes apply immediately and are force-applied on every DSH launch.',
      statusDesktop: 'DSH desktop app detected.',
      statusNotDesktop: 'Not running in the DSH desktop app, so the window size cannot be changed here.',
      statusPatched: 'The window channel is ready.',
      statusNotPatched: 'The window channel is not injected yet; after injecting, restart DSH twice.',
      statusError: 'Last attempt failed: {message}',
    }

    /** 接入 locale 服务后由它提供的文案表（Proxy）；未接入时为 null。 */
    var boundStrings = null

    /**
     * 浏览器语言（取不到就当作英文）。
     *
     * @returns {string} 小写的语言标签。
     */
    function browserLanguage() {
      try {
        return String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase()
      } catch (error) {
        return ''
      }
    }

    /**
     * 当前语言下的文案表：优先用 locale 服务，否则按 navigator 猜。
     *
     * @returns {{section: string, sectionDescription: string}} 文案表（或它的 Proxy）。
     */
    function strings() {
      if (boundStrings) return boundStrings
      return browserLanguage().indexOf('zh') === 0 ? ZH : EN
    }

    /**
     * 把内置字典登记给 locale 服务，并绑定成 `strings()` 的优先来源。
     *
     * 任何一步失败都退回「按 navigator 猜语言」，不影响分区渲染。
     *
     * @param {object} ctx - 客户端上下文。
     */
    function installLocale(ctx) {
      boundStrings = null
      try {
        if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return
        ctx.locale.register(NS, { zh: ZH, en: EN })
        if (typeof ctx.locale.bind !== 'function') return
        var translate = ctx.locale.bind(NS)
        if (typeof translate !== 'function' || typeof Proxy !== 'function') return
        boundStrings = new Proxy(
          {},
          {
            get: function (_target, key) {
              return translate(String(key))
            },
          },
        )
      } catch (error) {
        boundStrings = null
      }
    }

    /**
     * 设置页里的占位分区：标题 + 一行说明。
     *
     * @returns {object} React 元素。
     */
    function Section() {
      var L = strings()
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 0' } },
        React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, L.section),
        React.createElement(
          'div',
          { style: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 } },
          L.sectionDescription,
        ),
      )
    }

    /**
     * 客户端入口。
     *
     * @param {object} ctx - 客户端上下文，应含 `slots` 与 `locale`。
     */
    function apply(ctx) {
      installLocale(ctx)
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        ctx.slots.inject('settings.section', function () {
          try {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: SECTION_ORDER,
                label: function () {
                  return strings().section
                },
              },
              Section,
            )
          } catch (error) {
            return undefined
          }
        })
      } catch (error) {
        /* 设置页还没就绪：少一个分区，不影响 DSH 正常使用 */
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.locales = { zh: ZH, en: EN }

    return module.exports
  },
})
