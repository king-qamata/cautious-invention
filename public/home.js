import { createApiClient } from './js/api-client.js';

const themeKey = 'mindset_home_theme';
const workspaceViews = new Set(['campaigns', 'intake', 'consultations', 'referrals', 'providers', 'reports', 'patient-portal', 'account']);
const home = document.querySelector('#public-home');
const app = document.querySelector('#app');
const mobileNav = document.querySelector('.mobile-nav');
const drawerBackdrop = document.querySelector('#drawerBackdrop');
const publicApi = createApiClient({ token: '' });
let workspaceAppLoad = null;

function loadWorkspaceApp() {
  if (workspaceAppLoad) return;
  workspaceAppLoad = import('./app.js').catch((error) => {
    workspaceAppLoad = null;
    const message = document.querySelector('#workspaceLoadError');
    message.hidden = false;
    console.error('Unable to load the clinician workspace.', error);
  });
}

function syncPageMode() {
  const match = window.location.hash.match(/^#workspace(?:\/([a-z]+))?$/);
  const requestedView = match?.[1] && workspaceViews.has(match[1]) ? match[1] : '';
  const isWorkspace = Boolean(match);
  const wasWorkspace = document.body.classList.contains('workspace-mode');

  home.hidden = isWorkspace;
  app.hidden = !isWorkspace;
  mobileNav.hidden = !isWorkspace;
  drawerBackdrop.hidden = !isWorkspace;
  document.body.classList.toggle('workspace-mode', isWorkspace);

  if (isWorkspace !== wasWorkspace) {
    window.scrollTo(0, 0);
    requestAnimationFrame(() => (isWorkspace ? document.querySelector('#viewTitle') : home).focus());
  }

  if (requestedView) {
    app.dataset.initialView = requestedView;
    if (document.documentElement.dataset.appReady === 'true') {
      window.dispatchEvent(new CustomEvent('mindset:workspace-view', { detail: requestedView }));
    }
  } else {
    delete app.dataset.initialView;
  }

  if (isWorkspace) loadWorkspaceApp();
}

function setTheme(theme) {
  document.documentElement.dataset.homeTheme = theme;
  try {
    localStorage.setItem(themeKey, theme);
  } catch (error) {
    console.warn('Unable to save the homepage theme preference.', error);
  }
  const toggle = document.querySelector('#themeToggle');
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  toggle.textContent = `${nextTheme === 'dark' ? 'Dark' : 'Light'} mode`;
  toggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

function initializeTheme() {
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem(themeKey);
  } catch (error) {
    console.warn('Unable to read the saved homepage theme preference.', error);
  }
  const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(['light', 'dark'].includes(savedTheme) ? savedTheme : preferredTheme);
}

function initIntake() {
  const form = document.querySelector('#homeIntakeForm');
  const careFor = document.querySelector('#homeCareFor');
  const familyAuthorizationField = document.querySelector('#familyAuthorizationField');
  const familyAuthorization = document.querySelector('#familyAuthorization');
  const submitButton = document.querySelector('#homeSubmit');
  const message = document.querySelector('#homeIntakeMessage');
  const confirmation = document.querySelector('#homeConfirmation');
  const urgency = document.querySelector('#homeUrgency');
  let submitting = false;

  careFor.addEventListener('change', () => {
    const isFamilyEnquiry = careFor.value === 'family';
    familyAuthorizationField.hidden = !isFamilyEnquiry;
    familyAuthorization.required = isFamilyEnquiry;
    familyAuthorization.checked = false;
  });

  document.querySelector('#homeAnotherEnquiry').addEventListener('click', () => {
    confirmation.hidden = true;
    form.hidden = false;
    form.reset();
    familyAuthorizationField.hidden = true;
    familyAuthorization.required = false;
    familyAuthorization.checked = false;
    message.textContent = '';
    document.querySelector('#homeName').focus();
  });

  document.querySelectorAll('[data-home-tier]').forEach((link) => {
    link.addEventListener('click', () => {
      urgency.value = link.dataset.homeTier;
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    submitting = true;
    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    submitButton.textContent = 'Sending enquiry…';
    message.textContent = '';
    message.removeAttribute('role');

    const formData = new FormData(form);
    const careType = formData.get('careType');
    const healthcareRequirement = `Care type: ${careType}\n\n${String(formData.get('healthcareRequirement') || '').trim()}`;
    const payload = {
      name: formData.get('name'),
      phone: formData.get('phone'),
      email: formData.get('email'),
      careFor: formData.get('careFor'),
      representativeAuthorized: familyAuthorization.checked,
      location: formData.get('location'),
      country: formData.get('country'),
      healthcareRequirement,
      preferredUrgency: formData.get('preferredUrgency'),
      consentGiven: formData.get('consentGiven') === 'true',
      source: 'website',
      channel: 'website'
    };

    try {
      const lead = await publicApi('/api/v1/leads', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      document.querySelector('#homeLeadReference').textContent = lead.id || 'Reference unavailable';
      form.reset();
      familyAuthorizationField.hidden = true;
      familyAuthorization.required = false;
      familyAuthorization.checked = false;
      form.hidden = true;
      confirmation.hidden = false;
      confirmation.focus();
    } catch (error) {
      message.setAttribute('role', 'alert');
      const requestReference = error.requestId ? ` Reference: ${error.requestId}.` : '';
      const retryDelay = error.retryAfter ? ` Try again in ${error.retryAfter} seconds.` : '';
      message.textContent = `${error.message}${retryDelay}${requestReference}`;
      submitButton.disabled = false;
      submitButton.textContent = 'Send care enquiry';
    } finally {
      submitting = false;
      submitButton.removeAttribute('aria-busy');
    }
  });
}

document.querySelector('#themeToggle').addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.homeTheme === 'dark' ? 'light' : 'dark';
  setTheme(nextTheme);
});

window.addEventListener('hashchange', syncPageMode);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Unable to register the service worker.', error);
    });
  });
}
initializeTheme();
initIntake();
syncPageMode();
