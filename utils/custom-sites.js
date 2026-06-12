// utils/custom-sites.js
// Sites personnalises : enregistrement dynamique du content script
// Charge dans la page options (options.html) ET dans le background
// (importScripts cote Chrome, background.scripts cote Firefox)
// → utiliser `self`, jamais `window`/`document`.
//
// Securite : aucun acces supplementaire n'est accorde a l'installation.
// Chaque domaine ajoute declenche la demande de permission native du
// navigateur (optional_host_permissions), revocable a tout moment par
// l'utilisateur depuis chrome://extensions.
(function() {
  'use strict';

  if (!self.PseudoShield) self.PseudoShield = {};

  // Domaines couverts par les content_scripts statiques du manifest :
  // jamais enregistres dynamiquement (sinon double injection)
  const BUILT_IN_DOMAINS = [
    'claude.ai',
    'chatgpt.com',
    'gemini.google.com',
    'copilot.microsoft.com',
    'chat.deepseek.com',
    'perplexity.ai'
  ];

  const SCRIPT_ID_PREFIX = 'pseudoshield-custom-';
  const ALL_SITES_SCRIPT_ID = 'pseudoshield-all-sites';

  /**
   * Patterns d'origine pour un domaine : domaine nu + sous-domaines,
   * HTTPS uniquement — meme regle de matching que la whitelist de content.js
   * @param {string} domain - Domaine valide par DOMAIN_REGEX (options.js)
   * @returns {string[]} Patterns pour permissions.request / matches
   */
  function originsFor(domain) {
    return ['https://' + domain + '/*', 'https://*.' + domain + '/*'];
  }

  /**
   * Reutilise la definition des content_scripts du manifest (js, css, run_at)
   * pour que les sites personnalises chargent exactement le meme code que
   * les 6 plateformes integrees — une seule source de verite
   */
  function contentScriptDefinition() {
    const cs = chrome.runtime.getManifest().content_scripts[0];
    return { js: cs.js, css: cs.css, runAt: cs.run_at };
  }

  /**
   * Enregistre le content script pour un domaine personnalise (idempotent)
   * Prerequis : la permission d'hote a deja ete accordee par l'utilisateur
   */
  async function registerSite(domain) {
    const id = SCRIPT_ID_PREFIX + domain;
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length > 0) return;

    const def = contentScriptDefinition();
    await chrome.scripting.registerContentScripts([{
      id: id,
      matches: originsFor(domain),
      js: def.js,
      css: def.css,
      runAt: def.runAt,
      persistAcrossSessions: true
    }]);
  }

  /**
   * Desenregistre le content script d'un domaine et revoque la permission
   */
  async function unregisterSite(domain) {
    const id = SCRIPT_ID_PREFIX + domain;
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    }
    try {
      await chrome.permissions.remove({ origins: originsFor(domain) });
    } catch (e) {
      // Permission deja revoquee par l'utilisateur — non bloquant
    }
  }

  /**
   * Active le mode « tous les sites » (idempotent)
   * Prerequis : la permission globale (tous les hotes https) est accordee
   * Les 6 domaines du manifest sont exclus (deja couverts statiquement)
   */
  async function registerAllSites() {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_SCRIPT_ID] });
    if (existing.length > 0) return;

    const manifest = chrome.runtime.getManifest();
    const def = contentScriptDefinition();
    await chrome.scripting.registerContentScripts([{
      id: ALL_SITES_SCRIPT_ID,
      matches: ['https://*/*'],
      excludeMatches: manifest.content_scripts[0].matches,
      js: def.js,
      css: def.css,
      runAt: def.runAt,
      persistAcrossSessions: true
    }]);
  }

  /**
   * Desactive le mode « tous les sites » et revoque la permission globale
   * (les permissions par domaine des sites personnalises sont conservees)
   */
  async function unregisterAllSites() {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_SCRIPT_ID] });
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT_ID] });
    }
    try {
      await chrome.permissions.remove({ origins: ['https://*/*'] });
    } catch (e) {
      // Permission deja revoquee — non bloquant
    }
  }

  /**
   * Resynchronise les enregistrements dynamiques avec le storage :
   * - reenregistre les sites personnalises dont la permission est accordee
   *   (necessaire apres une mise a jour de l'extension : les scripts
   *   dynamiques ne survivent pas a l'update, contrairement au storage) ;
   * - desenregistre les scripts orphelins (domaine retire de la liste ou
   *   permission revoquee par l'utilisateur via chrome://extensions).
   */
  async function syncRegisteredSites() {
    const result = await chrome.storage.local.get(['pseudoshield_whitelist', 'pseudoshield_allSites']);
    const whitelist = result.pseudoshield_whitelist || [];
    const customDomains = whitelist.filter((d) => !BUILT_IN_DOMAINS.includes(d));

    const registered = await chrome.scripting.getRegisteredContentScripts();

    // Scripts par domaine : retirer les orphelins, reenregistrer les valides
    for (const script of registered) {
      if (!script.id.startsWith(SCRIPT_ID_PREFIX)) continue;
      const domain = script.id.slice(SCRIPT_ID_PREFIX.length);
      if (!customDomains.includes(domain)) {
        await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
      }
    }
    for (const domain of customDomains) {
      const granted = await chrome.permissions.contains({ origins: originsFor(domain) });
      if (granted) {
        await registerSite(domain);
      }
    }

    // Script « tous les sites »
    const allSitesGranted = await chrome.permissions.contains({ origins: ['https://*/*'] });
    if (result.pseudoshield_allSites === true && allSitesGranted) {
      await registerAllSites();
    } else {
      const allSites = registered.filter((s) => s.id === ALL_SITES_SCRIPT_ID);
      if (allSites.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT_ID] });
      }
    }
  }

  self.PseudoShield.CustomSites = {
    BUILT_IN_DOMAINS: BUILT_IN_DOMAINS,
    originsFor: originsFor,
    registerSite: registerSite,
    unregisterSite: unregisterSite,
    registerAllSites: registerAllSites,
    unregisterAllSites: unregisterAllSites,
    syncRegisteredSites: syncRegisteredSites
  };
})();
