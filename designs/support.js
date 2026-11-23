/*
 * support.js — ตัวรันขนาดเล็กสำหรับเปิดหน้าต้นแบบ (prototype) ในเบราว์เซอร์โดยตรง
 * รองรับ: {{hole}} · <sc-if value> · <sc-for list as> · onClick/onChange/onSubmit · setState
 * ใช้คู่กับไฟล์ *.html ในโฟลเดอร์นี้เท่านั้น (ต้นฉบับสำหรับ canvas อยู่ใน source/)
 */
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; }
    setState(patch) {
      const p = typeof patch === 'function' ? patch(this.state || {}, this.props) : patch;
      this.state = Object.assign({}, this.state || {}, p);
      if (this.__render) this.__render();
    }
    forceUpdate() { if (this.__render) this.__render(); }
  }
  window.DCLogic = DCLogic;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const BOOL = new Set(['disabled', 'checked', 'readonly', 'selected', 'hidden', 'required', 'multiple']);

  function lookup(expr, scope) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    const q = expr.match(/^(['"])(.*)\1$/);
    if (q) return q[2];
    let v = scope;
    for (const k of expr.split('.')) { if (v == null) return undefined; v = v[k]; }
    return v;
  }

  function holes(str, scope, handlers) {
    str = str.replace(/(\s)([A-Za-z_:][\w:.-]*)="\{\{\s*([^{}]+?)\s*\}\}"/g, (all, sp, name, expr) => {
      const v = lookup(expr, scope);
      if (/^on[A-Z]/.test(name)) {
        if (typeof v !== 'function') return '';
        const id = handlers.push(v) - 1;
        return sp + 'data-dc-' + name.slice(2).toLowerCase() + '="' + id + '"';
      }
      if (BOOL.has(name.toLowerCase())) return v ? sp + name : '';
      if (v == null) return '';
      return sp + name + '="' + esc(v) + '"';
    });
    return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (a, e) => { const v = lookup(e, scope); return v == null ? '' : esc(v); });
  }

  function render(tpl, scope, handlers) {
    let out = '';
    let i = 0;
    const re = /<sc-(for|if)\b/g;
    for (;;) {
      re.lastIndex = i;
      const m = re.exec(tpl);
      if (!m) { out += holes(tpl.slice(i), scope, handlers); break; }
      out += holes(tpl.slice(i, m.index), scope, handlers);
      const tag = 'sc-' + m[1];
      const openEnd = tpl.indexOf('>', m.index);
      const openTag = tpl.slice(m.index, openEnd + 1);
      const tr = new RegExp('<(/?)' + tag + '\\b', 'g');
      let depth = 1, j = openEnd + 1, bodyEnd = -1;
      while (depth > 0) {
        tr.lastIndex = j;
        const t = tr.exec(tpl);
        if (!t) throw new Error('unclosed <' + tag + '>');
        depth += t[1] ? -1 : 1;
        if (depth === 0) { bodyEnd = t.index; j = tpl.indexOf('>', t.index) + 1; } else j = tr.lastIndex;
      }
      const body = tpl.slice(openEnd + 1, bodyEnd);
      const attr = (n) => { const a = openTag.match(new RegExp('\\s' + n + '="([^"]*)"')); return a ? a[1] : null; };
      const val = (s) => { const h = s && s.match(/^\{\{\s*([^{}]+?)\s*\}\}$/); return h ? lookup(h[1], scope) : s; };
      if (m[1] === 'if') {
        if (val(attr('value'))) out += render(body, scope, handlers);
      } else {
        const list = val(attr('list')) || [];
        const as = attr('as') || 'item';
        list.forEach((it, idx) => {
          const child = Object.create(scope);
          child[as] = it;
          child.$index = idx;
          out += render(body, child, handlers);
        });
      }
      i = j;
    }
    return out;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const tplEl = document.querySelector('script[type="text/x-dc-template"]');
    const sEl = document.querySelector('script[data-dc-script]');
    if (!tplEl || !sEl) return;
    let tpl = tplEl.textContent.replace(/<helmet>([\s\S]*?)<\/helmet>/, (a, inner) => {
      document.head.insertAdjacentHTML('beforeend', inner);
      return '';
    });
    const props = {};
    try {
      const dp = JSON.parse(sEl.getAttribute('data-props') || '{}');
      for (const k in dp) if (k[0] !== '$' && dp[k] && 'default' in dp[k]) props[k] = dp[k].default;
    } catch (e) { /* ใช้ค่าตั้งต้นในโค้ด */ }
    const Comp = new Function('DCLogic', sEl.textContent + '\nreturn Component;')(DCLogic);
    const inst = new Comp(props);
    inst.props = props;
    const root = document.createElement('div');
    tplEl.parentNode.insertBefore(root, tplEl);
    inst.__render = () => {
      const handlers = [];
      root.innerHTML = render(tpl, inst.renderVals() || {}, handlers);
      root.querySelectorAll('*').forEach((el) => {
        for (const a of Array.from(el.attributes)) {
          if (!a.name.startsWith('data-dc-')) continue;
          const fn = handlers[Number(a.value)];
          if (fn) el.addEventListener(a.name.slice(8), (e) => fn(e));
        }
      });
    };
    inst.__render();
    if (inst.componentDidMount) inst.componentDidMount();
  });
})();
