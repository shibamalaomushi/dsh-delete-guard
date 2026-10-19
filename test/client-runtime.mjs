/**
 * Client-half smoke test: evaluates client.js under a minimal module loader and
 * applies it to mock slots/locale services. This catches top-level errors and
 * manifest/registration mistakes without a browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
let definition = null
const slashButton = {
  textContent: 'sessions会话管理：列出、删除（进回收站）、排队、还原',
  children: [],
  firstChild: null,
  querySelector() {
    return this.children.find((node) => node.className === 'dsm-commandIcon' || node.tagName === 'svg') ?? null
  },
  insertBefore(node) {
    this.children.unshift(node)
  },
}
const documentMock = {
  head: { appendChild() {} },
  createElement: (tag) => ({
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    setAttribute() {},
    remove() {},
    click() {},
  }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  body: { appendChild() {}, removeChild() {} },
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
  querySelectorAll: (selector) => (String(selector).includes('role="option"') ? [slashButton] : []),
}
const context = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  URL,
  Blob: class {},
  document: documentMock,
  MutationObserver: class {
    constructor(callback) {
      this.callback = callback
    }
    observe() {
      this.callback()
    }
    disconnect() {}
  },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: {},
  window: {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (callback) => {
      callback()
      return 1
    },
  },
}
vm.runInNewContext(source, context, { filename: 'client.js' })

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
  } else {
    fail += 1
    console.log(`FAIL ${name} ${extra}`)
  }
}

check('client.js 注册 __ModuleLoader__ 定义', Boolean(definition && definition.id === 'dsh-delete-guard'))
check('client.js 惰性工厂返回 inject/apply', Boolean(definition && typeof definition.factory === 'function'))
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  Children: { only: (value) => value },
  cloneElement: (value) => value,
}
const moduleValue = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('client.js 只 require react', Boolean(moduleValue && typeof moduleValue.apply === 'function'))
const slots = []
const dictionaries = []
const effects = []
const ctx = {
  effect: (callback, label) => {
    effects.push(label)
    const dispose = typeof callback === 'function' ? callback() : null
    return dispose
  },
  locale: {
    register: (ns, values) => {
      dictionaries.push({ ns, values })
      return () => {}
    },
    bind: () => (key, vars) => {
      const dict = dictionaries[0]?.values?.zh ?? {}
      let text = dict[key] ?? key
      if (vars) for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value))
      return text
    },
  },
  slots: {
    inject: (name, callback) => {
      slots.push(name)
      callback()
    },
    register: (meta) => {
      slots.push(meta.name)
      return () => {}
    },
  },
  layout: { selectPanel() {} },
  get: () => undefined,
}
let applied = true
try {
  moduleValue.apply(ctx)
} catch (error) {
  applied = false
  console.log(`FAIL apply() threw: ${error && error.stack ? error.stack : error}`)
}
check('client apply() 不抛异常', applied)
check('client 注册中英字典', dictionaries.length === 1 && dictionaries[0].values.zh && dictionaries[0].values.en)
check(
  'client 注册侧边栏/主面板/行入口',
  ['sidebar.panellist', 'main', 'sidebar.workspaces.session.row.action', 'sidebar.workspaces.session.menu.item'].every((name) =>
    slots.includes(name),
  ),
  JSON.stringify(slots),
)
check('client 为 /sessions 菜单行插入图标', slashButton.children[0]?.className === 'dsm-commandIcon', JSON.stringify(slashButton.children))

console.log(`\n客户端冒烟：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
