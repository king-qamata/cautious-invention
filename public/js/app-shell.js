export function createAppShellController(deps) {
  const {
    qs,
    qsa,
    accordionStateKey = 'mindset_topbar_accordion'
  } = deps;

  function isMobileViewport() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function openDrawer() {
    document.body.classList.add('drawer-open');
    const menuToggle = qs('#menuToggleBtn');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'true');
  }

  function closeDrawer() {
    document.body.classList.remove('drawer-open');
    const menuToggle = qs('#menuToggleBtn');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
  }

  function readAccordionState() {
    try {
      return JSON.parse(localStorage.getItem(accordionStateKey) || '{}');
    } catch {
      return {};
    }
  }

  function writeAccordionState(nextState) {
    localStorage.setItem(accordionStateKey, JSON.stringify(nextState));
  }

  function setAccordionOpen(section, isOpen) {
    const item = qs(`.topbar-accordion-item[data-accordion="${section}"]`);
    const toggle = qs(`[data-accordion-toggle="${section}"]`);
    if (!item || !toggle) return;
    item.classList.toggle('is-open', isOpen);
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function toggleAccordion(section) {
    const saved = readAccordionState();
    const isOpen = Boolean(saved[section]);
    const next = { ...saved, [section]: !isOpen };
    writeAccordionState(next);
    setAccordionOpen(section, !isOpen);
  }

  function restoreAccordionState() {
    const saved = readAccordionState();
    setAccordionOpen('summary', Boolean(saved.summary));
    setAccordionOpen('account', Boolean(saved.account));
  }

  function prepareCampaign(campaign, switchView) {
    switchView('intake');
    const channel = qs('#leadForm select[name="channel"]');
    const careFor = qs('#leadForm select[name="careFor"]');

    if (campaign === 'diaspora') {
      channel.value = 'diaspora';
      careFor.value = 'family';
    } else if (campaign === 'referrer') {
      channel.value = 'social';
      careFor.value = 'self';
    } else {
      channel.value = 'social';
      careFor.value = 'self';
    }

    qs('#leadForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    qs('#leadForm input[name="name"]').focus();
  }

  function toggleRouteCard(card) {
    if (!card) return;
    const isOpen = card.classList.contains('is-open');
    qsa('[data-route-card]').forEach((node) => {
      node.classList.remove('is-open');
      node.setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      card.classList.add('is-open');
      card.setAttribute('aria-expanded', 'true');
    }
  }

  return {
    isMobileViewport,
    openDrawer,
    closeDrawer,
    toggleAccordion,
    restoreAccordionState,
    prepareCampaign,
    toggleRouteCard
  };
}
