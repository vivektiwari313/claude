'use strict';

const WEAPONS = [
  {
    name: 'Sword',
    icon: '<path d="M20 3h1v1l-10 10-2-2z"/><path d="M5 13l6 6M7 15l-3 3M3 21l2-2" stroke-linecap="round"/>',
  },
  {
    name: 'Bow',
    icon: '<path d="M8 3c7 1 12 6 13 13"/><path d="M8 3l13 13" stroke-width="1"/><path d="M3 21L15 9M15 9h-3M15 9v3M3 21h3M3 21v-3" stroke-linecap="round"/>',
  },
  {
    name: 'Axe',
    icon: '<path d="M14 10L4 20" stroke-linecap="round"/><path d="M12 4c4-2 7 1 8 3s1 5-1 7c-2-1-3-2-4-3s-3-3-3-7z" fill="currentColor"/>',
  },
  {
    name: 'Hammer',
    icon: '<path d="M13 9L4 18l2 2 9-9" stroke-linejoin="round"/><rect x="11" y="3" width="10" height="6" rx="1" transform="rotate(45 16 6)" fill="currentColor"/>',
  },
  {
    name: 'Spear',
    icon: '<path d="M4 20L16 8" stroke-linecap="round"/><path d="M15 9l1-5 4-1-1 4z" fill="currentColor"/>',
  },
  {
    name: 'Dagger',
    icon: '<path d="M17 4l3 0 0 3-7 7-3-3z" fill="currentColor"/><path d="M8 11l5 5M8 16l-4 4" stroke-linecap="round"/>',
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
  weaponStatus.textContent = 'Choose a weapon.';
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

function onWeaponClick(btn, weapon) {
  const wasEquipped = btn.getAttribute('aria-pressed') === 'true';
  weaponsEl.querySelectorAll('.weapon').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  if (wasEquipped) {
    weaponStatus.textContent = `${selectedUser.name} put away the ${weapon.name.toLowerCase()}.`;
  } else {
    btn.setAttribute('aria-pressed', 'true');
    weaponStatus.textContent = `${selectedUser.name} equipped the ${weapon.name.toLowerCase()}!`;
  }
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
