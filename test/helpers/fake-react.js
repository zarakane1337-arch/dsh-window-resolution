/**
 * 极简假 React + 挂载器：让设置页组件能在 Node 里被真正「渲染 → 交互 → 卸载」。
 *
 * 为什么需要它：设置页是一个有状态的 React 函数组件（`useState` / `useEffect` /
 * `useRef`），只用 `component()` 直接调用没法验证「选择后立刻生效」「卸载后定时器
 * 被清掉」这类 T03 的核心行为。这里实现 hooks 的最小语义：
 *
 * - `useState` 的 setter 同步触发重渲染（React 18 的 `act()` 等价物）；
 * - `useEffect` 在每次渲染后按依赖数组决定是否执行，返回值作为清理函数；
 * - `unmount()` 按注册顺序执行所有清理函数 —— 泄漏的监听/定时器会在这里暴露。
 *
 * 它不是 React 的替代品，只覆盖本仓库客户端用到的子集，语义与真实 React 一致
 * （hooks 顺序固定、依赖浅比较、卸载后 setState 被忽略）。
 *
 * @packageDocumentation
 */

import { textOf } from './client-harness.js'

/**
 * 浅比较两个依赖数组。
 *
 * @param {unknown[] | undefined} previous - 上一次的依赖。
 * @param {unknown[] | undefined} next - 这一次的依赖。
 * @returns {boolean} 是否视为相同。
 */
function depsEqual(previous, next) {
  if (!previous || !next) return previous === next
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

/**
 * 造一个假 React 与配套的挂载器。
 *
 * @returns {{
 *   react: object,
 *   mount: (component: Function, props?: object) => {
 *     tree: unknown, text: string, unmount: () => void, element: unknown,
 *   },
 * }} 假 React 与 `mount()`。
 */
export function createReact() {
  /** 当前正在渲染的组件实例（hooks 只能在这个窗口里调用）。 */
  let active = null

  /**
   * 取当前渲染实例上的第 N 个 hook 槽。
   *
   * 顺序即 hook 身份：同一个位置换了 hook 类型就是组件写错了，直接抛错（与
   * React 的「Rendered fewer hooks than expected」同类）。
   *
   * @param {string} kind - `state` / `ref` / `effect` / `memo`。
   * @returns {{slot: object, index: number, inst: object}} 槽位、序号与所属实例。
   */
  function hookSlot(kind) {
    if (!active) throw new Error(`hooks（${kind}）只能在组件渲染期间调用`)
    const inst = active
    const index = inst.index++
    let slot = inst.hooks[index]
    if (!slot) {
      slot = { kind }
      inst.hooks[index] = slot
    } else if (slot.kind !== kind) {
      throw new Error(`第 ${index} 个 hook 的类型从 ${slot.kind} 变成了 ${kind}`)
    }
    return { slot, index, inst }
  }

  /**
   * 渲染（或重渲染）一个组件实例，并按顺序执行本轮排队的 effect。
   *
   * setState 在渲染/effect 里再次触发时会置脏并循环，而不是递归重入；循环上限
   * 用来把「渲染里无限 setState」变成一条明确的测试失败，而不是挂死。
   *
   * @param {object} inst - 组件实例。
   */
  function renderInstance(inst) {
    if (!inst.mounted) return
    if (inst.busy) {
      inst.dirty = true
      return
    }
    inst.busy = true
    const outer = active
    try {
      let rounds = 0
      do {
        inst.dirty = false
        inst.index = 0
        inst.pending = []
        active = inst
        try {
          inst.tree = inst.component(inst.props)
        } finally {
          active = outer
        }
        const queued = inst.pending
        inst.pending = []
        for (const effect of queued) {
          if (typeof effect.slot.cleanup === 'function') {
            effect.slot.cleanup()
            effect.slot.cleanup = undefined
          }
          const cleanup = effect.fn()
          effect.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
        if (++rounds > 50) throw new Error('组件反复重渲染（疑似渲染期 setState 死循环）')
      } while (inst.dirty)
    } finally {
      inst.busy = false
    }
  }

  /**
   * 请求一次重渲染；卸载后的请求被静默忽略（与真实 React 一致）。
   *
   * @param {object} inst - 组件实例。
   */
  function requestRender(inst) {
    if (!inst.mounted) return
    renderInstance(inst)
  }

  const react = {
    /**
     * 与 React 同形的元素工厂。
     *
     * @param {string | Function} type - 标签名或组件。
     * @param {object | null} props - 属性。
     * @param {...unknown} children - 子节点。
     * @returns {{type: unknown, props: object, children: unknown[]}} 假元素。
     */
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2).flat()
      return { type, props: props || {}, children }
    },

    /**
     * 有状态值。
     *
     * @param {unknown | (() => unknown)} initial - 初始值或惰性初始化函数。
     * @returns {[unknown, (next: unknown | ((previous: unknown) => unknown)) => void]} 值与 setter。
     */
    useState(initial) {
      const { slot, inst } = hookSlot('state')
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
      return [
        slot.value,
        function setValue(next) {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          requestRender(inst)
        },
      ]
    },

    /**
     * 可变引用（`current` 跨渲染保持同一个对象）。
     *
     * @param {unknown} initial - 初始值。
     * @returns {{current: unknown}} 引用对象。
     */
    useRef(initial) {
      const { slot } = hookSlot('ref')
      if (!('current' in slot)) slot.current = initial
      return slot
    },

    /**
     * 依赖不变时复用上一次的结果。
     *
     * @param {() => unknown} factory - 计算函数。
     * @param {unknown[]} deps - 依赖。
     * @returns {unknown} 计算结果。
     */
    useMemo(factory, deps) {
      const { slot } = hookSlot('memo')
      if (!slot.ready || !depsEqual(slot.deps, deps)) {
        slot.value = factory()
        slot.deps = deps
        slot.ready = true
      }
      return slot.value
    },

    /**
     * 依赖不变时复用同一个函数。
     *
     * @param {Function} fn - 函数。
     * @param {unknown[]} deps - 依赖。
     * @returns {Function} 稳定引用。
     */
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps)
    },

    /**
     * 副作用：依赖变化时执行，返回值作为清理函数。
     *
     * @param {() => (void | (() => void))} fn - 副作用。
     * @param {unknown[]} [deps] - 依赖；省略表示每次渲染都执行。
     */
    useEffect(fn, deps) {
      const { slot, inst, index } = hookSlot('effect')
      if (!slot.ready || !depsEqual(slot.deps, deps)) {
        inst.pending.push({ slot, index, fn, deps })
      }
      slot.deps = deps
      slot.ready = true
    },
  }

  /**
   * 挂载一个函数组件。
   *
   * @param {Function} component - 组件函数。
   * @param {object} [props] - 传给组件的 props。
   * @returns {{
   *   element: unknown, get tree(): unknown, get text(): string,
   *   unmount: () => void,
   * }} 视图：可读元素树/纯文本，可卸载。
   */
  function mount(component, props = {}) {
    const inst = {
      component,
      props,
      hooks: [],
      index: 0,
      pending: [],
      busy: false,
      dirty: false,
      mounted: true,
      tree: null,
    }
    renderInstance(inst)
    return {
      element: inst.tree,
      get tree() {
        return inst.tree
      },
      get text() {
        return textOf(inst.tree)
      },
      unmount() {
        inst.mounted = false
        inst.busy = true
        try {
          for (const slot of inst.hooks) {
            if (slot && typeof slot.cleanup === 'function') {
              slot.cleanup()
              slot.cleanup = undefined
            }
          }
        } finally {
          inst.busy = false
        }
      },
    }
  }

  return { react, mount }
}

/**
 * 深度优先收集元素树里满足条件的节点。
 *
 * @param {unknown} node - 假元素树（可能含数组）。
 * @param {(element: {type: unknown, props: object, children: unknown[]}) => boolean} predicate - 匹配条件。
 * @param {object[]} [found] - 累积结果（递归用）。
 * @returns {object[]} 匹配的元素，按文档顺序。
 */
export function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) collect(child, predicate, found)
  }
  return found
}

/**
 * 收集所有单选框（`input[type=radio]`）。
 *
 * @param {unknown} tree - 假元素树。
 * @returns {object[]} 单选框元素。
 */
export function radios(tree) {
  return collect(tree, (node) => node.type === 'input' && node.props && node.props.type === 'radio')
}

/**
 * 收集所有数字输入框（`input[type=number]`）。
 *
 * @param {unknown} tree - 假元素树。
 * @returns {object[]} 数字输入框元素。
 */
export function numberInputs(tree) {
  return collect(tree, (node) => node.type === 'input' && node.props && node.props.type === 'number')
}
