// Skills: the services the business's AI assistant can offer customers. A skill is a reviewed file shipped with the application (read-only here); this page lists them,
// shows what each one does and what it may use, and switches each on or off for the SELECTED business. Everything is read and written through the dashboard API, which
// scopes it to the selected business and enforces the user's permission on the server — what is hidden here is only a convenience. Nothing is invented: an empty list says so.

const SKILL_RUN_RESULT = { answered: ['Answered', 'green'], failed: ['Failed', 'red'], started: ['In progress', 'amber'] };
const SKILL_SELECTION = { explicit: 'Customer asked for it', automatic: 'Matched automatically' };
const skillWhen = (v) => (v ? formatDate(`${String(v).replace(' ', 'T')}Z`) : '—');
const canEditSkills = () => can('ai', 'edit');

function skillStatusBadge(s) {
  if (!s.available) return badge('Not available', 'muted');
  return s.enabled ? badge('Enabled', 'green') : badge('Disabled', 'muted');
}

function skillDetailHtml(detail) {
  const s = detail.skill;
  const tools = s.tools.length
    ? `<ul>${s.tools.map((t) => `<li><code>${esc(t.name)}</code> — ${esc(t.label)}</li>`).join('')}</ul>`
    : '<p class="muted">No tools — it only follows its instructions (and can hand the customer to a person).</p>';
  const runs = detail.recentRuns.length
    ? `<table class="data-table"><thead><tr><th>When</th><th>How chosen</th><th>Result</th><th>Tools</th></tr></thead><tbody>${detail.recentRuns.map((r) => {
      const [label, tone] = SKILL_RUN_RESULT[r.status] || [r.status, ''];
      return `<tr><td>${esc(skillWhen(r.at))}</td><td>${esc(SKILL_SELECTION[r.selection] || r.selection)}</td><td>${badge(label, tone)}</td><td>${r.tools.length ? esc(r.tools.join(', ')) : '—'}</td></tr>`;
    }).join('')}</tbody></table>`
    : '<p class="muted">No use yet.</p>';
  return `
    <div class="skill-detail" data-skill-detail="${esc(s.id)}">
      <h4>What it does</h4>
      <p>${esc(s.description)}</p>
      <h4>How customers reach it</h4>
      <p>Customers can ask for it by typing <code>${esc(s.invocation)}</code>.${s.triggers.length ? ` It is also chosen automatically when a message contains:` : ''}</p>
      ${s.triggers.length ? `<p>${s.triggers.map((t) => badge(t, '')).join(' ')}</p>` : ''}
      <h4>What it is allowed to use</h4>
      ${tools}
      <h4>Instructions the assistant follows</h4>
      <pre class="skill-instructions">${esc(s.instructions)}</pre>
      <h4>Recent use</h4>
      ${runs}
    </div>`;
}

route('#/skills', 'Skills', 'Switch on the services your assistant can offer customers, and see how they are used.', async (view) => {
  let data = null;
  let query = '';
  const opened = new Map(); // skill id -> rendered detail html

  const send = (method, url, body) => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  async function load() {
    view.innerHTML = '<p class="muted">Loading skills…</p>';
    try { data = await api('/api/dashboard/skills'); } catch (error) { view.innerHTML = `<p class="notice warn">${esc(error.message)}</p>`; return; }
    paint();
  }

  function rowHtml(s) {
    const editable = canEditSkills() && s.available;
    const used = s.runs.total ? `${s.runs.total}× · ${s.runs.failed ? `${s.runs.failed} failed` : 'no failures'}` : 'Not used yet';
    return `
      <article class="panel skill-card" data-skill="${esc(s.id)}">
        <div class="toolbar">
          <div>
            <strong>${esc(s.name)}</strong> ${skillStatusBadge(s)} ${s.choice === 'default' ? `<span class="muted small">${esc(s.defaultEnabled ? 'Default (on)' : 'Default (off)')}</span>` : ''}
            <div class="muted">${esc(s.description)}</div>
            ${s.available ? '' : `<div class="muted small">${esc(s.unavailableReason || '')}</div>`}
            <div class="muted small">${esc(used)}</div>
          </div>
          <div class="actions">
            <button type="button" class="btn small ghost" data-act="details">${opened.has(s.id) ? 'Hide details' : 'Details'}</button>
            ${editable ? `<button type="button" class="btn small" data-act="toggle" data-enable="${s.enabled ? '0' : '1'}">${s.enabled ? 'Disable' : 'Enable'}</button>` : ''}
          </div>
        </div>
        ${opened.has(s.id) ? opened.get(s.id) : ''}
      </article>`;
  }

  function paint() {
    const q = query.trim().toLowerCase();
    const list = data.skills.filter((s) => !q || `${s.name} ${s.description} ${s.id}`.toLowerCase().includes(q));
    view.innerHTML = `
      <p class="muted">Skills are reviewed files shipped with the application. Switching one on affects only the selected business, and only its own customers' conversations.</p>
      ${canEditSkills() ? '' : '<p class="notice">Your role can view skills but not change them.</p>'}
      <div class="toolbar"><input type="search" id="skill-search" placeholder="Search skills" aria-label="Search skills" value="${esc(query)}"></div>
      <div id="skill-list">${list.length ? list.map(rowHtml).join('') : `<p class="muted">${data.skills.length ? 'No skills match your search.' : 'No skills are installed on this server.'}</p>`}</div>
      ${data.problems.length ? `<section class="panel"><h3>Skill files that could not be loaded</h3><p class="muted">These files are ignored until they are fixed:</p><ul>${data.problems.map((p) => `<li><code>${esc(p.id)}</code> — ${esc(p.problems.join('; '))}</li>`).join('')}</ul></section>` : ''}`;

    const search = view.querySelector('#skill-search');
    search.addEventListener('input', () => { query = search.value; paint(); view.querySelector('#skill-search').focus(); });
    view.querySelectorAll('[data-skill]').forEach((card) => {
      const id = card.getAttribute('data-skill');
      card.querySelectorAll('button[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const act = btn.getAttribute('data-act');
        try {
          if (act === 'details') {
            if (opened.has(id)) opened.delete(id); else opened.set(id, skillDetailHtml(await api(`/api/dashboard/skills/${encodeURIComponent(id)}`)));
            paint();
          } else if (act === 'toggle') {
            btn.disabled = true;
            const enable = btn.getAttribute('data-enable') === '1';
            await send('PUT', `/api/dashboard/skills/${encodeURIComponent(id)}`, { enabled: enable });
            toast(enable ? 'Skill enabled' : 'Skill disabled', 'success');
            opened.delete(id);
            await load();
          }
        } catch (error) {
          toast(error.message, 'error');
          btn.disabled = false;
        }
      }));
    });
  }

  await load();
});
