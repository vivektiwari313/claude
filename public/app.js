'use strict';

const WEAPONS = [
  {
    name: 'Hammer',
    icon: '<path d="M13 9L4 18l2 2 9-9" stroke-linejoin="round"/><rect x="11" y="3" width="10" height="6" rx="1" transform="rotate(45 16 6)" fill="currentColor"/>',
  },
  {
    name: 'Shoe',
    icon: '<path d="M2 18V10.5h4.5l2 3 4 1 5.5 1.2c2.3.5 4 1.4 4 3.3v-.9V18z" stroke-linejoin="round"/><path d="M2 18h20M9.2 13.4l1.4-1.8M12 14.2l1.4-1.8" stroke-linecap="round"/>',
  },
  {
    name: 'Egg',
    icon: '<path d="M12 2.5c-3.9 0-7 6-7 11.5a7 7 0 0 0 14 0c0-5.5-3.1-11.5-7-11.5z"/><path d="M9 10c.4-1.3 1.1-2.4 2-3.1" stroke-linecap="round" stroke-width="1.5"/>',
  },
  {
    name: 'Chain Saw',
    icon: '<rect x="10" y="10.5" width="12" height="5" rx="2.5"/><path d="M11.5 8.8h9" stroke-dasharray="1.5 1.5"/><path d="M2.5 9h7.5v8H3.5a1 1 0 0 1-1-1z" fill="currentColor" stroke-linejoin="round"/><path d="M4 9V6.5A1.5 1.5 0 0 1 5.5 5H9v4" stroke-linejoin="round"/>',
  },
  {
    name: 'Gun',
    icon: '<path d="M22 7H3v4.5h3L4 19.5h4.5l1.8-5.5H14v-2.5h8z" stroke-linejoin="round"/><path d="M10.3 14c.2 1.4 1.2 2.2 2.4 2.2.8 0 1.3-.5 1.3-1.2V14" stroke-linecap="round"/>',
  },
  {
    name: 'Pen',
    icon: '<path d="M16.5 3.5l4 4L8 20l-5 1 1-5z" stroke-linejoin="round"/><path d="M14 6l4 4M4 16l4 4" stroke-linecap="round"/>',
  },
];

const DEBOUNCE_MS = 120;

const input = document.getElementById('search-input');
const list = document.getElementById('suggestions');
const profile = document.getElementById('profile');
const profileName = document.getElementById('profile-name');
const profilePicture = document.getElementById('profile-picture');
const weaponsEl = document.getElementById('weapons');
const weaponStatus = document.getElementById('weapon-status');
const emptyState = document.getElementById('empty-state');

let suggestions = [];
let activeIndex = -1;
let debounceTimer;
let requestSeq = 0;
let selectedUser = null;

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function highlight(name, query) {
  const i = name.toLowerCase().indexOf(query.toLowerCase());
  if (!query || i === -1) return escapeHtml(name);
  return escapeHtml(name.slice(0, i))
    + `<mark>${escapeHtml(name.slice(i, i + query.length))}</mark>`
    + escapeHtml(name.slice(i + query.length));
}

// Shows the user's photo, switching to their generated picture if the photo can't load.
function setPicture(img, user) {
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => {
    img.onerror = null;
    if (user.fallback && img.src !== user.fallback) img.src = user.fallback;
  };
  img.src = user.picture;
}

function closeSuggestions() {
  list.hidden = true;
  list.innerHTML = '';
  suggestions = [];
  activeIndex = -1;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function renderSuggestions(query) {
  list.innerHTML = '';
  if (suggestions.length === 0) {
    list.innerHTML = '<li class="suggestion no-results">No users found</li>';
  }
  suggestions.forEach((user, i) => {
    const li = document.createElement('li');
    li.className = 'suggestion';
    li.id = `suggestion-${user.id}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === activeIndex));
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    setPicture(img, user);
    const label = document.createElement('span');
    label.innerHTML = highlight(user.name, query.trim());
    li.append(img, label);
    // mousedown fires before the input's blur, so the list is still there when we pick.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectUser(user);
    });
    list.appendChild(li);
  });
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function setActive(index) {
  if (suggestions.length === 0) return;
  activeIndex = (index + suggestions.length) % suggestions.length;
  [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === activeIndex)));
  const active = list.children[activeIndex];
  input.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

async function fetchSuggestions(query) {
  const seq = ++requestSeq;
  try {
    const data = await window.UserApi.search(query);
    // Ignore responses that arrive after a newer keystroke's request.
    if (seq !== requestSeq || input.value.trim() !== query.trim()) return;
    suggestions = data;
    activeIndex = -1;
    renderSuggestions(query);
  } catch (err) {
    console.error('Search failed', err);
  }
}

function selectUser(user) {
  selectedUser = user;
  input.value = user.name;
  closeSuggestions();

  profileName.textContent = user.name;
  setPicture(profilePicture, user);
  profilePicture.alt = `${user.name}'s display picture`;
  renderWeapons();
  weaponStatus.textContent = NO_WEAPON_TEXT;
  weaponStatus.classList.remove('is-selected');
  profile.hidden = false;
  emptyState.hidden = true;
}

function renderWeapons() {
  weaponsEl.innerHTML = '';
  WEAPONS.forEach((weapon) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weapon';
    btn.title = weapon.name;
    btn.setAttribute('aria-label', weapon.name);
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${weapon.icon}</svg>`;
    btn.addEventListener('click', () => onWeaponClick(btn, weapon));
    weaponsEl.appendChild(btn);
  });
}

const NO_WEAPON_TEXT = 'Select a weapon';

// Clicking a weapon selects it; clicking the selected one again clears the selection.
function onWeaponClick(btn, weapon) {
  const wasSelected = btn.getAttribute('aria-pressed') === 'true';
  weaponsEl.querySelectorAll('.weapon').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  if (!wasSelected) btn.setAttribute('aria-pressed', 'true');
  weaponStatus.textContent = wasSelected ? NO_WEAPON_TEXT : weapon.name;
  weaponStatus.classList.toggle('is-selected', !wasSelected);
}

input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const query = input.value;
  if (!query.trim()) {
    requestSeq++;
    closeSuggestions();
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(query), DEBOUNCE_MS);
});

input.addEventListener('keydown', (e) => {
  if (list.hidden) {
    if (e.key === 'ArrowDown' && input.value.trim()) fetchSuggestions(input.value);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(activeIndex + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(activeIndex - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const user = suggestions[activeIndex >= 0 ? activeIndex : 0];
    if (user) selectUser(user);
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
});

input.addEventListener('focus', () => {
  if (input.value.trim() && (!selectedUser || input.value !== selectedUser.name)) {
    fetchSuggestions(input.value);
  }
});

input.addEventListener('blur', closeSuggestions);
