/**
 * dsh-plugin-resolution — 浏览器半边（Client half）。
 *
 * 由 DSH 的客户端模块加载器执行：这里没有 ESM 语法，唯一的依赖是宿主提供的
 * `react`。它做两件事 —— 在设置页注册 `settings.section` 分区（T01），以及
 * 在每次启动时按持久化配置应用窗口尺寸（T04）。
 *
 * ## 约束
 *
 * - **静默降级**：上下文缺服务、插槽还没就绪、locale 服务不可用、窗口通道缺席，
 *   都只是少一块 UI 或这次不生效，绝不抛错 —— 抛错会让整个设置页挂掉。
 * - **资源有归属**：启动应用注册一个 `ctx.effect` 持有重试定时器与
 *   `visibilitychange` 监听，由 `ctx.effect` 的清理函数统一释放；除这次 effect 外
 *   不注册全局事件、不改 app root、不碰别人的 DOM。
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

    // ------------------------------------------------------------------ //
    // 启动应用（T04）
    //
    // 页面加载完成后，按持久化配置把主窗口设成目标尺寸。桥由 preload 注入，
    // 可能比页面晚一点就绪，所以这里是「带预算的自适应重试」而不是一次调用：
    //   - 通道在：最多 10 次、间隔 400ms（主进程/窗口可能还没 ready）
    //   - 通道不在：最多 3 次、间隔 600ms（注入需要重启，别死等）
    // 成功一次就停；失败只写 debug 日志，绝不抛错、绝不阻断界面。
    //
    // 配置与 T03 设置页共用 `dsh-plugin-resolution:config`；应用成功后的**实际**
    // bounds（可能被钳制）另存 `dsh-plugin-resolution:last-applied`，这样设置页
    // 能展示真实尺寸，窗口重新可见时也能判断"是不是被系统改过、要不要补回来"。
    // ------------------------------------------------------------------ //

    /** 启动应用读写的存储键（config / lastApplied 与设置页共享）。 */
    var STARTUP_CONFIG_KEY = 'dsh-plugin-resolution:config'
    var STARTUP_LAST_APPLIED_KEY = 'dsh-plugin-resolution:last-applied'
    var STARTUP_STATUS_KEY = 'dsh-plugin-resolution:status'

    /** 契约边界（与 `lib/contract.js` 的 `MIN_SIDE` / `MAX_SIDE` 一致）。 */
    var STARTUP_MIN_SIDE = 200
    var STARTUP_MAX_SIDE = 16384

    /**
     * 重试策略。默认值即产品行为；抽成对象是为了让预算与间隔只有一处定义，
     * 也方便单测/以后按平台调参。
     */
    var STARTUP_POLICY = {
      attemptsWithBridge: 10,
      delayWithBridgeMs: 400,
      attemptsWithoutBridge: 3,
      delayWithoutBridgeMs: 600,
      reapplyDebounceMs: 1000,
    }

    /**
     * 取 `window`（拿不到就返回 null，绝不抛错）。
     *
     * @returns {object | null} 浏览器窗口对象。
     */
    function startupWindow() {
      try {
        return typeof window !== 'undefined' && window ? window : null
      } catch (error) {
        return null
      }
    }

    /**
     * 取 `document`（优先全局，其次 `window.document`）。
     *
     * @returns {object | null} 文档对象。
     */
    function startupDocument() {
      try {
        if (typeof document !== 'undefined' && document) return document
      } catch (error) {
        /* 取全局失败时退回 window.document */
      }
      var host = startupWindow()
      try {
        return host && host.document ? host.document : null
      } catch (error) {
        return null
      }
    }

    /**
     * 取 `localStorage`（隐私模式/被禁用时拿不到，所有调用方都要容忍 null）。
     *
     * @returns {object | null} 存储对象。
     */
    function startupStorage() {
      var host = startupWindow()
      try {
        var storage = host && host.localStorage
        if (
          storage &&
          typeof storage.getItem === 'function' &&
          typeof storage.setItem === 'function'
        ) {
          return storage
        }
      } catch (error) {
        /* 访问 localStorage 本身就可能抛（部分隐私设置） */
      }
      return null
    }

    /**
     * 当前页面协议。桌面端是 `dsh-app:`；浏览器标签页是 `http(s):`。
     *
     * @returns {string} 协议（带冒号），取不到时为空串。
     */
    function startupProtocol() {
      try {
        if (typeof location !== 'undefined' && location) return String(location.protocol || '')
      } catch (error) {
        /* 退回 window.location */
      }
      var host = startupWindow()
      try {
        return host && host.location ? String(host.location.protocol || '') : ''
      } catch (error) {
        return ''
      }
    }

    /**
     * 是否运行在 DSH 桌面端。浏览器标签页里绝不尝试改窗口。
     *
     * @returns {boolean} 是否为 `dsh-app:` 页面。
     */
    function startupIsDesktop() {
      return startupProtocol() === 'dsh-app:'
    }

    /**
     * 启动期诊断日志：只在有 `console.debug` 时输出，且永远不抛错。
     *
     * @param {string} message - 日志正文。
     */
    function startupDebug(message) {
      var host = startupWindow()
      try {
        var target = host && host.console
        if (target && typeof target.debug === 'function') {
          target.debug('[dsh-plugin-resolution] ' + message)
        }
      } catch (error) {
        /* 日志失败不影响任何功能 */
      }
    }

    /** @returns {number} 当前时间戳（毫秒）。 */
    function startupNow() {
      try {
        return Date.now()
      } catch (error) {
        return 0
      }
    }

    /**
     * 判定一个边长是否在契约区间内（整数、200..16384）。
     *
     * @param {unknown} value - 待判定取值。
     * @returns {boolean} 是否可用。
     */
    function startupSide(value) {
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.floor(value) === value &&
        value >= STARTUP_MIN_SIDE &&
        value <= STARTUP_MAX_SIDE
      )
    }

    /**
     * 把存储里的配置归一成「可应用」或「关闭」。
     *
     * 规则与 `lib/config.js` 的 `normalizeConfig()` 保持一致（非法 → 关闭），
     * 但不复制预设表：`presetValue` 本身就是 `"1920x1080"` 形态，尺寸字段缺失
     * 时可以直接从它解析，避免旧版本/半写配置被当成"关闭"。
     *
     * @param {unknown} raw - 反序列化后的配置。
     * @returns {{mode: string, width: number, height: number} | null} 归一结果。
     */
    function startupNormalizeConfig(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      var mode = raw.mode
      if (mode !== 'preset' && mode !== 'custom' && mode !== 'off') return null
      if (mode === 'off') return { mode: 'off', width: 0, height: 0 }
      var width = raw.width
      var height = raw.height
      if ((!startupSide(width) || !startupSide(height)) && typeof raw.presetValue === 'string') {
        var parts = raw.presetValue.split('x')
        if (parts.length === 2) {
          var parsedWidth = Number(parts[0])
          var parsedHeight = Number(parts[1])
          if (startupSide(parsedWidth) && startupSide(parsedHeight)) {
            width = parsedWidth
            height = parsedHeight
          }
        }
      }
      if (!startupSide(width) || !startupSide(height)) return null
      return { mode: mode, width: width, height: height }
    }

    /**
     * 读当前配置。存储不可用或内容非法时返回 null（调用方按"关闭"处理）。
     *
     * @returns {{mode: string, width: number, height: number} | null} 配置。
     */
    function startupReadConfig() {
      var storage = startupStorage()
      if (!storage) return null
      try {
        var raw = storage.getItem(STARTUP_CONFIG_KEY)
        if (!raw) return null
        return startupNormalizeConfig(JSON.parse(raw))
      } catch (error) {
        return null
      }
    }

    /**
     * 读最近一次真正应用后的 bounds。
     *
     * @returns {{width: number, height: number, x?: number, y?: number, at?: number} | null} 记录。
     */
    function startupReadLastApplied() {
      var storage = startupStorage()
      if (!storage) return null
      try {
        var raw = storage.getItem(STARTUP_LAST_APPLIED_KEY)
        if (!raw) return null
        var parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        if (!startupSide(parsed.width) || !startupSide(parsed.height)) return null
        return parsed
      } catch (error) {
        return null
      }
    }

    /**
     * 配置尺寸是否已经等于最近一次真正应用的结果。
     *
     * 用于两处「已知窗口就是目标尺寸，不必再调桥」：热重载时的重复 `apply()`，
     * 以及窗口重新可见时的补应用。注意启动时**不能**用它跳过：上一轮会话留下
     * 的 lastApplied 与配置一致，但窗口可能已被系统改过，必须重设一次。
     *
     * @param {{width: number, height: number}} config - 归一后的配置。
     * @returns {boolean} 是否已生效。
     */
    function startupSettled(config) {
      var last = startupReadLastApplied()
      return !!(last && last.width === config.width && last.height === config.height)
    }

    /**
     * 把实际应用后的 bounds 记到 `last-applied`（不污染主配置键）。
     *
     * @param {unknown} bounds - 主进程回传的实际 bounds（可能缺席/被钳制）。
     * @param {{width: number, height: number}} requested - 请求的尺寸。
     * @returns {object} 写入的记录（存储失败也返回，便于调用方展示）。
     */
    function startupRecordLastApplied(bounds, requested) {
      var record = { width: requested.width, height: requested.height, at: startupNow() }
      if (bounds && typeof bounds === 'object') {
        if (startupSide(bounds.width) && startupSide(bounds.height)) {
          record.width = bounds.width
          record.height = bounds.height
        }
        if (typeof bounds.x === 'number' && Math.floor(bounds.x) === bounds.x) record.x = bounds.x
        if (typeof bounds.y === 'number' && Math.floor(bounds.y) === bounds.y) record.y = bounds.y
      }
      var storage = startupStorage()
      if (storage) {
        try {
          storage.setItem(STARTUP_LAST_APPLIED_KEY, JSON.stringify(record))
        } catch (error) {
          /* 存储不可用时仅本次生效 */
        }
      }
      return record
    }

    /**
     * 写一行启动状态，供设置页读取展示（非桌面 / 未注入 / 已应用 / 失败）。
     *
     * @param {string} state - 状态标识。
     * @param {object} [detail] - 附加字段（错误码、实际尺寸等）。
     */
    function startupWriteStatus(state, detail) {
      var storage = startupStorage()
      if (!storage) return
      var record = { state: state, at: startupNow() }
      if (detail && typeof detail === 'object') {
        for (var key in detail) {
          if (Object.prototype.hasOwnProperty.call(detail, key)) record[key] = detail[key]
        }
      }
      try {
        storage.setItem(STARTUP_STATUS_KEY, JSON.stringify(record))
      } catch (error) {
        /* 状态只是展示用途，写不进去不影响功能 */
      }
    }

    /**
     * 取窗口通道。只认契约里的 `setBounds`；未注入时整个命名空间缺席。
     *
     * @returns {{setBounds: Function} | null} 可用的桥。
     */
    function startupBridge() {
      var host = startupWindow()
      if (!host) return null
      try {
        var api = host.dshWindowResolution
        if (!api || typeof api.setBounds !== 'function') return null
        /*
         * 契约：v 是版本常量，`v !== 1` 视为不兼容、按 not-patched 降级，不猜旧
         * 版本语义。桥整体缺席（含 v 缺席）时也走同一条"通道未就绪"路径。
         */
        if (api.v !== undefined && api.v !== 1) return null
        return api
      } catch (error) {
        /* 属性访问抛错等同于未注入 */
      }
      return null
    }

    /**
     * 调一次 `setBounds`，并把「抛错 / reject / `{ok:false}` / `{ok:true}`」
     * 归一成永远 resolve 的报文 —— 重试逻辑不该被异常打断。
     *
     * @param {{setBounds: Function}} api - 窗口通道。
     * @param {{width: number, height: number}} target - 目标尺寸。
     * @returns {Promise<object>} 归一后的结果。
     */
    function startupCallSetBounds(api, target) {
      return new Promise(function (resolve) {
        var output
        try {
          output = api.setBounds({ width: target.width, height: target.height })
        } catch (error) {
          resolve({ ok: false, code: 'rejected', message: String((error && error.message) || error) })
          return
        }
        Promise.resolve(output).then(
          function (value) {
            if (value && value.ok === true) {
              resolve({ ok: true, bounds: value.bounds })
            } else if (value && value.ok === false) {
              resolve({ ok: false, code: value.code, message: value.message })
            } else {
              /* 非契约返回值（如旧桥返回 undefined）：当作已接受，避免无谓重试。 */
              resolve({ ok: true, bounds: null })
            }
          },
          function (error) {
            resolve({ ok: false, code: 'rejected', message: String((error && error.message) || error) })
          },
        )
      })
    }

    /**
     * 这个错误码是否值得重试。
     *
     * `invalid` 是配置问题、`not-desktop` / `not-patched` 是环境问题，重试都不会
     * 变好；`no-window` / `rejected` 在启动早期是暂态的（窗口还没建好），值得等。
     *
     * @param {unknown} code - 契约错误码。
     * @returns {boolean} 是否重试。
     */
    function startupRetryable(code) {
      return code !== 'invalid' && code !== 'not-desktop' && code !== 'not-patched'
    }

    /**
     * 合并重试策略（默认值 + 覆盖项）。
     *
     * @param {object} [overrides] - 覆盖项。
     * @returns {object} 完整策略。
     */
    function startupPolicy(overrides) {
      var merged = {}
      var key
      for (key in STARTUP_POLICY) {
        if (Object.prototype.hasOwnProperty.call(STARTUP_POLICY, key)) merged[key] = STARTUP_POLICY[key]
      }
      if (overrides && typeof overrides === 'object') {
        for (key in overrides) {
          if (Object.prototype.hasOwnProperty.call(overrides, key)) merged[key] = overrides[key]
        }
      }
      return merged
    }

    /** 当前挂着的启动控制器（热重载时先释放旧的，避免叠加定时器/监听器）。 */
    var activeStartup = null

    /** 当前控制器是否真的挂到了 `ctx.effect` 上（只有挂上才谈得上复用）。 */
    var activeStartupManaged = false

    /**
     * 创建一个启动控制器：立即应用一次（带重试），并监听窗口重新可见。
     *
     * 返回 null 表示本次运行无事可做（非桌面端 / 配置为关闭），调用方不必登记
     * `ctx.effect` —— 没有资源需要清理。
     *
     * @param {object} [overrides] - 重试策略覆盖（单测用）。
     * @returns {{dispose: Function} | null} 控制器。
     */
    function startupCreate(overrides) {
      if (!startupIsDesktop()) {
        startupWriteStatus('not-desktop')
        return null
      }
      var initial = startupReadConfig()
      if (!initial || initial.mode === 'off') {
        startupWriteStatus('off')
        return null
      }

      var policy = startupPolicy(overrides)
      var stopped = false
      var retryTimer = null
      var debounceTimer = null
      var bridgeAttempts = 0
      var noBridgeAttempts = 0
      var documentObject = startupDocument()

      /**
       * 清一个定时器（定时器句柄来自 `window.setTimeout`）。
       *
       * @param {unknown} id - 定时器句柄。
       */
      function clearTimer(id) {
        var host = startupWindow()
        try {
          if (id !== null && host && typeof host.clearTimeout === 'function') host.clearTimeout(id)
        } catch (error) {
          /* 清理失败也不能抛 */
        }
      }

      /** 清掉待执行的重试。 */
      function clearRetry() {
        if (retryTimer === null) return
        clearTimer(retryTimer)
        retryTimer = null
      }

      /** 清掉待执行的可见性 debounce。 */
      function clearDebounce() {
        if (debounceTimer === null) return
        clearTimer(debounceTimer)
        debounceTimer = null
      }

      /**
       * 安排一次重试。拿不到定时器（极端环境）就返回 false，让调用方放弃。
       *
       * @param {number} delay - 间隔毫秒。
       * @param {Function} callback - 到期执行。
       * @returns {boolean} 是否安排成功。
       */
      function schedule(delay, callback) {
        var host = startupWindow()
        if (!host || typeof host.setTimeout !== 'function') return false
        try {
          retryTimer = host.setTimeout(function () {
            retryTimer = null
            callback()
          }, delay)
          return true
        } catch (error) {
          return false
        }
      }

      /** 尝试应用一次；失败按预算安排下一次。 */
      function attempt() {
        if (stopped) return
        var config = startupReadConfig()
        if (!config || config.mode === 'off') {
          startupWriteStatus('off')
          return
        }
        var api = startupBridge()
        if (!api) {
          noBridgeAttempts += 1
          if (
            noBridgeAttempts < policy.attemptsWithoutBridge &&
            schedule(policy.delayWithoutBridgeMs, attempt)
          ) {
            startupWriteStatus('pending', { attempts: noBridgeAttempts })
            return
          }
          startupWriteStatus('not-patched', { attempts: noBridgeAttempts })
          startupDebug('window bridge absent after ' + noBridgeAttempts + ' attempts; giving up')
          return
        }
        bridgeAttempts += 1
        startupWriteStatus('pending', { attempts: bridgeAttempts })
        startupCallSetBounds(api, config).then(function (result) {
          if (stopped) return
          try {
            if (result && result.ok) {
              var applied = startupRecordLastApplied(result.bounds, config)
              startupWriteStatus('applied', { width: applied.width, height: applied.height })
              return
            }
            var code = result && result.code
            var message = result && result.message
            if (!startupRetryable(code)) {
              startupWriteStatus('failed', { code: code, message: message })
              startupDebug('setBounds refused: ' + code + ' ' + message)
              return
            }
            if (bridgeAttempts < policy.attemptsWithBridge && schedule(policy.delayWithBridgeMs, attempt)) {
              return
            }
            startupWriteStatus('failed', { code: code, message: message })
            startupDebug('setBounds failed after ' + bridgeAttempts + ' attempts: ' + code + ' ' + message)
          } catch (error) {
            startupDebug('startup apply bookkeeping failed: ' + String((error && error.message) || error))
          }
        })
      }

      /** 窗口重新可见：配置与上次实际应用不一致时补一次（1s debounce）。 */
      function reapply() {
        if (stopped) return
        var config = startupReadConfig()
        if (!config || config.mode === 'off') {
          startupWriteStatus('off')
          return
        }
        if (startupSettled(config)) return
        bridgeAttempts = 0
        noBridgeAttempts = 0
        attempt()
      }

      /** `visibilitychange` 处理：只在"变为可见"时 debounce 重应用。 */
      function onVisibilityChange() {
        if (stopped) return
        var currentDocument = startupDocument()
        if (!currentDocument) return
        var visible
        if (typeof currentDocument.visibilityState === 'string') {
          visible = currentDocument.visibilityState === 'visible'
        } else {
          visible = currentDocument.hidden !== true
        }
        if (!visible) return
        clearDebounce()
        var host = startupWindow()
        if (!host || typeof host.setTimeout !== 'function') return
        try {
          debounceTimer = host.setTimeout(function () {
            debounceTimer = null
            reapply()
          }, policy.reapplyDebounceMs)
        } catch (error) {
          /* debounce 安排失败就放弃这次补应用 */
        }
      }

      if (documentObject && typeof documentObject.addEventListener === 'function') {
        try {
          documentObject.addEventListener('visibilitychange', onVisibilityChange)
        } catch (error) {
          documentObject = null
        }
      }

      attempt()

      return {
        dispose: function () {
          if (stopped) return
          stopped = true
          clearRetry()
          clearDebounce()
          if (documentObject && typeof documentObject.removeEventListener === 'function') {
            try {
              documentObject.removeEventListener('visibilitychange', onVisibilityChange)
            } catch (error) {
              /* 清理失败不能抛 */
            }
          }
          documentObject = null
        },
      }
    }

    /**
     * 把启动控制器挂到 `ctx.effect` 上：重复 apply（热重载）先释放旧的，
     * 保证定时器与监听器不叠加。
     *
     * @param {object} ctx - 客户端上下文。
     */
    function installStartup(ctx) {
      var current = startupReadConfig()
      if (
        activeStartup &&
        activeStartupManaged &&
        current &&
        current.mode !== 'off' &&
        startupIsDesktop() &&
        startupSettled(current)
      ) {
        /* 热重载：配置已经生效，保留现有控制器，避免重复调桥与叠加监听。 */
        return
      }

      var controller = null
      try {
        controller = startupCreate()
      } catch (error) {
        startupDebug('startup disabled: ' + String((error && error.message) || error))
        return
      }

      if (activeStartup) {
        try {
          activeStartup.dispose()
        } catch (error) {
          /* 旧控制器清理失败不能拖垮新的一次 */
        }
        activeStartup = null
        activeStartupManaged = false
      }
      if (!controller) return
      activeStartup = controller

      var dispose = function () {
        if (activeStartup === controller) {
          activeStartup = null
          activeStartupManaged = false
        }
        try {
          controller.dispose()
        } catch (error) {
          /* 清理失败不能抛 */
        }
      }

      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(function () {
            return dispose
          }, 'dsh-plugin-resolution: startup apply')
          activeStartupManaged = true
          return
        } catch (error) {
          startupDebug('ctx.effect unavailable: ' + String((error && error.message) || error))
        }
      }
      /* 没有 effect 服务时仍保留控制器；下一次 apply 会替换它。 */
    }

    /**
     * 客户端入口。
     *
     * @param {object} ctx - 客户端上下文，应含 `slots` 与 `locale`。
     */
    function apply(ctx) {
      installLocale(ctx)
      installStartup(ctx)
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
