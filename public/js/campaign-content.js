const campaignTrustItems = [
  {
    title: 'Care coordination',
    description: 'One structured route from enquiry to provider handoff.'
  },
  {
    title: 'Provider visibility',
    description: 'Clear matching, status tracking, and referral readiness.'
  },
  {
    title: 'Family-first support',
    description: 'Simple access for patients, diaspora families, and referrers.'
  }
];

const campaignTierItems = [
  {
    tier: 'Normal',
    pricing: 'Voice-text · N1,000',
    note: 'For lower-urgency needs'
  },
  {
    tier: 'Priority',
    pricing: 'Voice call · N5,000',
    note: 'For needs needing faster discussion'
  },
  {
    tier: 'Super Priority',
    pricing: 'Video call · N10,000',
    note: 'For complex or higher-urgency needs'
  }
];

const campaignCards = [
  {
    className: 'patient-campaign',
    label: 'PATIENT CARE',
    title: 'Physical or mental health, one starting point.',
    description: 'Share what you need and a care coordinator will help identify the right provider and next step.'
  },
  {
    className: 'diaspora-campaign',
    label: 'DIASPORA CARE',
    title: 'Trusted care for family back home.',
    description: 'Coordinate a care enquiry from wherever you are, for yourself on a visit or for someone in Nigeria.'
  },
  {
    className: 'referrer-campaign',
    label: 'REFERRER NETWORK',
    title: 'When you cannot see the patient, keep care moving.',
    description: 'Connect with Mindset to route appropriate patients into a participating provider network.'
  }
];

const campaignJourneyStages = ['Application', 'Screening', 'Provider match', 'Booking', 'Follow-up'];

const valueItems = [
  {
    title: 'Fast triage',
    description: 'Capture the need clearly, route it to the right team, and avoid missed follow-ups.'
  },
  {
    title: 'Trusted matching',
    description: 'Match the care need to a suitable provider, specialty, and service pathway.'
  },
  {
    title: 'Operational clarity',
    description: 'Track progress, documents, and transitions in one visible referral workflow.'
  }
];

function renderTrustStrip() {
  return `
    <div class="trust-strip" aria-label="Mindset healthcare advantages">
      ${campaignTrustItems
        .map(
          (item) => `
            <div class="trust-item">
              <strong>${item.title}</strong>
              <span>${item.description}</span>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderTierStrip() {
  return `
    <div class="tier-strip" aria-label="Consultation pathways">
      ${campaignTierItems
        .map(
          (item) => `
            <article>
              <span>${item.tier}</span>
              <strong>${item.pricing}</strong>
              <small>${item.note}</small>
            </article>
          `
        )
        .join('')}
    </div>
  `;
}

function renderCampaignCards() {
  return `
    <div class="campaign-grid campaign-grid-secondary">
      ${campaignCards
        .map(
          (item) => `
            <article class="campaign-card ${item.className}">
              <div class="campaign-card-bar" aria-hidden="true"></div>
              <div class="campaign-card-body">
                <span class="campaign-label">${item.label}</span>
                <h2>${item.title}</h2>
                <p>${item.description}</p>
                <p class="campaign-meta">Use the primary quickstart cards above to begin.</p>
              </div>
            </article>
          `
        )
        .join('')}
    </div>
  `;
}

function renderCampaignJourney() {
  return `
    <div class="campaign-journey">
      <div class="campaign-journey-heading">
        <h2>Built around the full care journey</h2>
        <span>Every path above feeds this pipeline</span>
      </div>
      <div class="campaign-steps" aria-label="Care journey stages">
        ${campaignJourneyStages
          .map(
            (stage, index) => `
              <div class="campaign-step"><span>${index + 1}</span><strong>${stage}</strong></div>
              ${index < campaignJourneyStages.length - 1 ? '<i aria-hidden="true"></i>' : ''}
            `
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderValuePanel() {
  return `
    <div class="value-panel">
      <div class="value-copy">
        <div class="campaign-kicker">WHY MINDSET</div>
        <h2>More than a referral form - a coordinated care experience.</h2>
        <p>Mindset helps patients, families, and referrers move from uncertainty to action with a clear clinical and operational path.</p>
      </div>
      <div class="value-grid">
        ${valueItems
          .map(
            (item) => `
              <article>
                <strong>${item.title}</strong>
                <p>${item.description}</p>
              </article>
            `
          )
          .join('')}
      </div>
    </div>
  `;
}

export function renderDeferredCampaignContent(qs) {
  const mount = qs('#campaignDeferredContent');
  if (!mount || mount.dataset.rendered === 'true') return;

  mount.innerHTML = `
    ${renderTrustStrip()}
    <div class="campaign-section-heading">
      <h2>Care paths at a glance</h2>
      <span>Quick summary cards for orientation after choosing a route above.</span>
    </div>
    ${renderTierStrip()}
    ${renderCampaignCards()}
    ${renderCampaignJourney()}
    ${renderValuePanel()}
  `;
  mount.dataset.rendered = 'true';
}

function renderCampaignDeferredSkeleton(qs) {
  const mount = qs('#campaignDeferredContent');
  if (!mount || mount.dataset.rendered === 'true' || mount.dataset.skeleton === 'true') return;

  mount.innerHTML = `
    <div class="campaign-deferred-skeleton" aria-hidden="true">
      <div class="campaign-skeleton-row campaign-skeleton-trust">
        <span></span><span></span><span></span>
      </div>
      <div class="campaign-skeleton-heading"></div>
      <div class="campaign-skeleton-row campaign-skeleton-tiers">
        <span></span><span></span><span></span>
      </div>
      <div class="campaign-skeleton-row campaign-skeleton-cards">
        <span></span><span></span><span></span>
      </div>
      <div class="campaign-skeleton-journey"></div>
      <div class="campaign-skeleton-value"></div>
    </div>
  `;

  mount.dataset.skeleton = 'true';
}

function renderWhenCampaignViewIsVisible(qs) {
  const campaignView = qs('#campaigns');
  if (!campaignView) {
    renderDeferredCampaignContent(qs);
    return;
  }

  if ('IntersectionObserver' in window) {
    const observer = new window.IntersectionObserver(
      (entries) => {
        const isVisible = entries.some((entry) => entry.isIntersecting);
        if (!isVisible) return;
        renderDeferredCampaignContent(qs);
        observer.disconnect();
      },
      {
        threshold: 0.2
      }
    );
    observer.observe(campaignView);
    return;
  }

  if (campaignView.classList.contains('active')) {
    renderDeferredCampaignContent(qs);
    return;
  }

  const tabs = [...document.querySelectorAll('[data-view="campaigns"]')];
  const onceRender = () => {
    renderDeferredCampaignContent(qs);
    tabs.forEach((tab) => tab.removeEventListener('click', onceRender));
  };
  tabs.forEach((tab) => tab.addEventListener('click', onceRender));
}

export function initDeferredCampaignContent(qs) {
  renderCampaignDeferredSkeleton(qs);
  renderWhenCampaignViewIsVisible(qs);
}
