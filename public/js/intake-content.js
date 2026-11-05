export function renderIntakeContent(qs) {
  const mount = qs('#intakeContentMount');
  if (!mount || mount.dataset.rendered === 'true') return;

  mount.innerHTML = `
    <div class="split">
      <form id="leadForm" class="panel">
        <h2>Start a care enquiry</h2>
        <p class="form-intro">Tell Mindset what support is needed. A care coordinator will review the request and help identify the next step.</p>
        <label>Name<input name="name" required placeholder="Patient or coordinator name"></label>
        <label>Phone<input name="phone" required placeholder="+234..."></label>
        <label>Email<input name="email" type="email" placeholder="optional"></label>
        <label>Care for
          <select name="careFor">
            <option value="self">Myself</option>
            <option value="family">A family member</option>
          </select>
        </label>
        <label>Location<input name="location" placeholder="Lagos"></label>
        <label>Country<input name="country" value="Nigeria"></label>
        <label>Channel
          <select name="channel">
            <option>website</option>
            <option>social</option>
            <option>clinician</option>
            <option>diaspora</option>
            <option>direct</option>
          </select>
        </label>
        <label>Healthcare Requirement<textarea name="healthcareRequirement" required placeholder="Describe the requested service"></textarea></label>
        <label>Preferred urgency
          <select name="preferredUrgency">
            <option value="normal">Normal - voice-text</option>
            <option value="priority">Priority - voice call</option>
            <option value="super_priority">Super Priority - video call</option>
          </select>
        </label>
        <label class="checkbox"><input name="consentGiven" type="checkbox" value="true" required> I consent to Mindset Healthcare contacting me about this request.</label>
        <p class="form-note">This service coordinates access to care. It is not an emergency service. If someone is in immediate danger, contact local emergency services.</p>
        <button>Send enquiry</button>
      </form>
      <div class="panel">
        <div class="panel-head">
          <h2>Lead Queue</h2>
          <button id="refreshLeads" class="secondary">Refresh</button>
        </div>
        <div id="leadList" class="list"></div>
      </div>
    </div>
  `;

  mount.dataset.rendered = 'true';
}
