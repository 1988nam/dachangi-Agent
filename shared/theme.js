(() => {
  const key = 'olchangi_theme';
  function apply(value) {
    const theme = value === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#10151e' : '#f7f8f6');
    const selector = document.getElementById('suite-theme');
    if (selector) selector.value = theme;
    if (window.Chart) Object.values(Chart.instances).forEach(chart => chart.update('none'));
  }
  let initial = 'dark';
  try { initial = localStorage.getItem(key) || initial; } catch {}
  apply(initial);
  window.OlchangiTheme = {
    set(value) { apply(value); try { localStorage.setItem(key, document.documentElement.dataset.theme); } catch {} },
  };
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(document.documentElement.dataset.theme);
    if (!window.Chart) return;
    function colors(chart) {
      const css = getComputedStyle(document.body), color = name => css.getPropertyValue(name).trim();
      const options = chart.config.options;
      options.color = color('--ink-soft');
      options.plugins ||= {};
      if (options.plugins.legend !== false) {
        options.plugins.legend ||= {};
        options.plugins.legend.labels ||= {};
        options.plugins.legend.labels.color = color('--ink-soft');
      }
      if (options.plugins.tooltip !== false) Object.assign(options.plugins.tooltip ||= {}, {
        backgroundColor: color('--surface'), titleColor: color('--ink'), bodyColor: color('--ink-soft'), borderColor: color('--line-strong'), borderWidth: 1,
      });
      for (const axis of Object.values(options.scales || {})) {
        (axis.ticks ||= {}).color = color('--ink-muted');
        (axis.grid ||= {}).color = color('--line');
        (axis.border ||= {}).color = color('--line');
        if (axis.title) axis.title.color = color('--ink-soft');
      }
      if (['pie', 'doughnut'].includes(chart.config.type)) chart.data.datasets.forEach(dataset => { dataset.borderColor = color('--surface'); });
    }
    Chart.register({ id: 'olchangiTheme', beforeInit: colors, beforeUpdate: colors });
    Object.values(Chart.instances).forEach(chart => chart.update('none'));
  });
})();
