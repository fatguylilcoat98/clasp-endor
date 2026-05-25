'use strict';
/* Test-door frontend. Vanilla; no build. */

(function () {
  const el = {
    setupCard:        document.getElementById('setup-card'),
    setupForm:        document.getElementById('setup-form'),
    setupSubmit:      document.getElementById('setup-submit'),
    setupError:       document.getElementById('setup-error'),
    nameInput:        document.getElementById('name-input'),
    companionInput:   document.getElementById('companion-name-input'),

    chatCard:         document.getElementById('chat-card'),
    displayName:      document.getElementById('display-name'),
    companionLabelOut:document.getElementById('companion-label-display'),
    transcript:       document.getElementById('transcript'),
    loading:          document.getElementById('loading'),
    chatError:        document.getElementById('chat-error'),
    chatForm:         document.getElementById('chat-form'),
    chatSubmit:       document.getElementById('chat-submit'),
    messageInput:     document.getElementById('message-input'),
    logoutButton:     document.getElementById('logout-button'),

    adminCard:        document.getElementById('admin-card'),
    adminRefresh:     document.getElementById('admin-refresh'),
    adminMeta:        document.getElementById('admin-meta'),
    adminTbody:       document.getElementById('admin-tbody'),
  };

  function setText(node, text) {
    node.textContent = text;
  }

  function showError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function clearError(node) {
    node.textContent = '';
    node.hidden = true;
  }

  function isAdminRole(userRole) {
    return userRole === 'admin';
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* leave null */ }
    return { ok: res.ok, status: res.status, body: payload };
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* leave null */ }
    return { ok: res.ok, status: res.status, body: payload };
  }

  function renderUserMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'message user';
    wrap.textContent = text;
    el.transcript.appendChild(wrap);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderCompanionMessage(text, governance) {
    const wrap = document.createElement('div');
    wrap.className = 'message companion';
    const body = document.createElement('div');
    body.textContent = text;
    wrap.appendChild(body);
    if (governance) wrap.appendChild(renderGovPanel(governance));
    el.transcript.appendChild(wrap);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderGovPanel(g) {
    const details = document.createElement('details');
    details.className = 'gov-panel';

    const summary = document.createElement('summary');
    const status = g.outcome || 'unknown';
    summary.innerHTML = 'Governance &amp; audit · '
      + '<span class="outcome-' + status + '">' + status + '</span>';
    details.appendChild(summary);

    const dl = document.createElement('dl');
    appendKv(dl, 'memoryCount',  String(g.memoryCount != null ? g.memoryCount : '—'));
    appendKv(dl, 'decision',     String(g.decision || '—'));
    appendKv(dl, 'reason',       String(g.reason || '—'));
    appendKv(dl, 'policyRef',    String(g.policyRef || '—'));
    appendKv(dl, 'intentType',   String(g.intentType || '—'));
    appendKv(dl, 'outcome',      String(g.outcome || '—'));
    appendKv(dl, 'staged?',      g.outcome === 'staged' ? 'yes' : 'no');
    appendKv(dl, 'rejected?',    g.outcome === 'rejected' ? 'yes' : 'no');
    appendKv(dl, 'allowed?',     g.outcome === 'executed' ? 'yes' : 'no');
    details.appendChild(dl);
    return details;
  }

  function appendKv(dl, key, value) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  async function onSetupSubmit(event) {
    event.preventDefault();
    clearError(el.setupError);
    el.setupSubmit.disabled = true;
    try {
      const name = el.nameInput.value.trim();
      const companionName = el.companionInput.value.trim();
      const roleNode = document.querySelector('input[name="role"]:checked');
      const role = roleNode ? roleNode.value : 'regular';
      if (!name) {
        showError(el.setupError, 'Please enter your name.');
        return;
      }
      const r = await postJson('/api/setup', { name, role, companionName });
      if (!r.ok) {
        showError(el.setupError, (r.body && r.body.error) || ('Setup failed (' + r.status + ').'));
        return;
      }
      enterChatMode(r.body);
    } catch (err) {
      showError(el.setupError, 'Network error. Check the server and try again.');
    } finally {
      el.setupSubmit.disabled = false;
    }
  }

  function enterChatMode(setup) {
    setText(el.displayName, setup.displayName);
    setText(
      el.companionLabelOut,
      setup.companionLabel ? setup.companionLabel : 'unnamed companion'
    );
    el.setupCard.hidden = true;
    el.chatCard.hidden = false;
    if (isAdminRole(setup.userRole)) {
      el.adminCard.hidden = false;
      refreshAdmin();
    } else {
      el.adminCard.hidden = true;
    }
    el.messageInput.focus();
  }

  async function onChatSubmit(event) {
    event.preventDefault();
    clearError(el.chatError);
    const message = el.messageInput.value.trim();
    if (!message) return;
    el.chatSubmit.disabled = true;
    el.loading.hidden = false;
    renderUserMessage(message);
    el.messageInput.value = '';
    try {
      const r = await postJson('/api/chat', { message });
      if (!r.ok) {
        const errMsg = (r.body && r.body.error) || ('Chat failed (' + r.status + ').');
        showError(el.chatError, errMsg);
        renderCompanionMessage('[no response — see error above]', {
          outcome: 'error',
          decision: null,
          reason: r.body && r.body.errorClass ? r.body.errorClass : null,
          policyRef: null,
          intentType: null,
          memoryCount: null,
        });
        if (!el.adminCard.hidden) refreshAdmin();
        return;
      }
      const b = r.body;
      renderCompanionMessage(b.response, {
        outcome: b.outcome,
        decision: b.decision,
        reason: b.reason,
        policyRef: b.policyRef,
        intentType: b.intentType,
        memoryCount: b.memoryCount,
      });
      if (!el.adminCard.hidden) refreshAdmin();
    } catch (err) {
      showError(el.chatError, 'Network error. The companion did not respond.');
    } finally {
      el.loading.hidden = true;
      el.chatSubmit.disabled = false;
    }
  }

  async function refreshAdmin() {
    try {
      const r = await getJson('/api/admin/recent');
      if (!r.ok) {
        el.adminMeta.textContent = 'Failed to load (' + r.status + ').';
        return;
      }
      const entries = (r.body && r.body.entries) || [];
      el.adminMeta.textContent = entries.length + ' / ' + (r.body.capacity || '?') + ' shown';
      el.adminTbody.innerHTML = '';
      for (const e of entries) {
        const tr = document.createElement('tr');
        tr.appendChild(td(e.ts));
        tr.appendChild(td(e.userRole));
        tr.appendChild(td(e.outcome));
        tr.appendChild(td(e.decision));
        tr.appendChild(td(e.reason));
        tr.appendChild(td(e.memoryCount != null ? String(e.memoryCount) : ''));
        tr.appendChild(td(e.responseChars != null ? String(e.responseChars) : ''));
        tr.appendChild(td(e.errorClass));
        el.adminTbody.appendChild(tr);
      }
    } catch (err) {
      el.adminMeta.textContent = 'Network error loading recent.';
    }
  }

  function td(text) {
    const node = document.createElement('td');
    node.textContent = text == null ? '' : String(text);
    return node;
  }

  async function onLogout() {
    try {
      await postJson('/api/logout', {});
    } catch (e) { /* swallow */ }
    window.location.reload();
  }

  el.setupForm.addEventListener('submit', onSetupSubmit);
  el.chatForm.addEventListener('submit', onChatSubmit);
  el.adminRefresh.addEventListener('click', refreshAdmin);
  el.logoutButton.addEventListener('click', onLogout);
  el.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      el.chatForm.requestSubmit();
    }
  });
})();
