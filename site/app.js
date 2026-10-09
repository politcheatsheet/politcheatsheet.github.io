(() => {
  const apiBase = (window.CARNET_API_BASE || "").replace(/\/$/, "");
  const tokenKey = "carnet-editor-token";
  const deviceIdKey = "carnet-editor-device-id";
  const themeKey = "policheatsheat-theme";
  const authorKey = "politcheatsheet-author";
  const usernameKey = "politcheatsheet-username";
  const maximumEmbeddedImages = 10;
  const maximumCompressedImageBytes = 250 * 1024;
  const maximumPdfBytes = 10 * 1024 * 1024;
  const deviceUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const state = { categories: [], topics: [], loading: { categories: true, topics: false }, selected: null, editor: false, username: "", pending: null, editorForm: null, detail: null, routeVersion: 0, search: { query: "", topics: [], loading: false } };
  const $ = (selector) => document.querySelector(selector);
  const categoryGrid = $("[data-category-grid]");
  const topicGrid = $("[data-topic-grid]");
  const searchResultsGrid = $("[data-search-results-grid]");
  const categoriesView = $("[data-categories-view]");
  const topicsView = $("[data-topics-view]");
  const searchResultsView = $("[data-search-results-view]");
  const notice = $("[data-notice]");
  const accessDialog = $("[data-access-dialog]");
  const editorDialog = $("[data-editor-dialog]");
  const detailDialog = $("[data-detail-dialog]");
  const imageDialog = $("[data-image-dialog]");
  const descriptionEditor = $("[data-description-editor]");
  const editorFeedback = $("[data-editor-feedback]");

  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
  function slugify(value) { return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "carte"; }
  function cardSlug(card) { return card.slug || slugify(card.title); }
  function categoryPath(category) { return `/${encodeURIComponent(cardSlug(category))}`; }
  function topicPath(topic) {
    const category = state.categories.find((item) => item.id === topic.categoryId);
    return category ? `${categoryPath(category)}/${encodeURIComponent(cardSlug(topic))}` : "/";
  }
  function isEmbeddedImage(value) { return /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(value); }
  function isStoredImage(value) { return /^media:\/\/images\/[0-9a-f-]+\.webp$/i.test(value); }
  function isStoredDocument(value) { return /^media:\/\/documents\/[0-9a-f-]+\.pdf$/i.test(value); }
  function mediaUrl(source) { return `${apiBase}/media/${source.slice("media://".length).split("/").map(encodeURIComponent).join("/")}`; }
  function imageUrl(source) { return isStoredImage(source) ? mediaUrl(source) : source; }
  function stripEmbeddedImages(value) { return String(value).replace(/!\[image\]\((?:data:image\/webp;base64,[A-Za-z0-9+/=]+|media:\/\/images\/[0-9a-f-]+\.webp)\)/gi, ""); }
  function embeddedImageMarkup(source) { return `<img src="${escapeHtml(imageUrl(source))}" data-image-source="${escapeHtml(source)}" data-action="expand-image" alt="Illustration ajoutée" loading="lazy">`; }
  function renderInlineMarkdown(value) {
    const tokens = [];
    const protect = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
    let output = escapeHtml(value);
    output = output.replace(/!\[image\]\((data:image\/webp;base64,[A-Za-z0-9+/=]+|media:\/\/images\/[0-9a-f-]+\.webp)\)/gi, (_, source) => protect(embeddedImageMarkup(source)));
    output = output.replace(/`([^`\n]+)`/g, (_, code) => protect(`<code>${code}</code>`));
    output = output.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s<>()]+|media:\/\/documents\/[0-9a-f-]+\.pdf)\)/gi, (_, label, url) => protect(`<a href="${escapeHtml(isStoredDocument(url) ? mediaUrl(url) : url)}" target="_blank" rel="noopener noreferrer">${label}</a>`));
    output = output.replace(/https?:\/\/[^\s<]+/gi, (candidate) => {
      const url = candidate.replace(/[.,!?;:]+$/, "");
      const trailing = candidate.slice(url.length);
      return url ? `${protect(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}${trailing}` : candidate;
    });
    output = output.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    output = output.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
    output = output.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, (_, italic, underscore) => `<em>${italic || underscore}</em>`);
    return output.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || "");
  }
  function renderMarkdown(value) {
    const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
    const blocks = []; let paragraph = []; let listType = ""; let listItems = []; let quote = [];
    const flushParagraph = () => { if (paragraph.length) blocks.push(`<p>${renderInlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`); paragraph = []; };
    const flushList = () => { if (listItems.length) blocks.push(`<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${listType}>`); listType = ""; listItems = []; };
    const flushQuote = () => { if (quote.length) blocks.push(`<blockquote>${renderInlineMarkdown(quote.join("\n")).replace(/\n/g, "<br>")}</blockquote>`); quote = []; };
    const flushBlocks = () => { flushParagraph(); flushList(); flushQuote(); };
    for (const line of lines) {
      if (!line.trim()) { flushBlocks(); continue; }
      const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
      if (heading) { flushBlocks(); const level = heading[1].length; blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`); continue; }
      if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushBlocks(); blocks.push("<hr>"); continue; }
      const quoteLine = line.match(/^>\s?(.*)$/);
      if (quoteLine) { flushParagraph(); flushList(); quote.push(quoteLine[1]); continue; }
      flushQuote();
      const unordered = line.match(/^[-+*]\s+(.+)$/); const ordered = line.match(/^\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph(); const nextType = unordered ? "ul" : "ol";
        if (listType && listType !== nextType) flushList();
        listType = nextType; listItems.push((unordered || ordered)[1]); continue;
      }
      flushList(); paragraph.push(line);
    }
    flushBlocks();
    return blocks.join("");
  }
  function renderEditorDescription(value) {
    const text = String(value); const imagePattern = /!\[image\]\((data:image\/webp;base64,[A-Za-z0-9+/=]+|media:\/\/images\/[0-9a-f-]+\.webp)\)/gi;
    let output = ""; let cursor = 0;
    for (const image of text.matchAll(imagePattern)) {
      output += escapeHtml(text.slice(cursor, image.index)).replace(/\n/g, "<br>");
      output += embeddedImageMarkup(image[1]);
      cursor = image.index + image[0].length;
    }
    return output + escapeHtml(text.slice(cursor)).replace(/\n/g, "<br>");
  }
  function markdownPlainText(value) {
    return stripEmbeddedImages(value).replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1").replace(/(^|\n)\s{0,3}(?:#{1,3}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/g, "$1").replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
  }
  function normalizeSearch(value) { return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase(); }
  function matchesSearch(card, query) {
    const words = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
    const cardText = normalizeSearch(`${card.title} ${card.author || ""} ${markdownPlainText(card.description)}`);
    return words.length === 0 || words.some((word) => cardText.includes(word));
  }
  function showNotice(message) { notice.textContent = message; notice.hidden = !message; }
  function authHeaders() { const token = sessionStorage.getItem(tokenKey); return token ? { Authorization: `Bearer ${token}` } : {}; }
  function apiUrl(path) { if (!apiBase) throw new Error("Le service d’édition est en cours de configuration."); return `${apiBase}${path}`; }
  async function request(path, options = {}) {
    const response = await fetch(apiUrl(path), { ...options, headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "La demande a échoué.");
    return body;
  }
  async function restoreRememberedSession() {
    const deviceId = localStorage.getItem(deviceIdKey);
    if (!deviceId || !deviceUuidPattern.test(deviceId)) return false;
    try {
      const data = await request("/session/remembered", { method: "POST", body: JSON.stringify({ deviceId }) });
      sessionStorage.setItem(tokenKey, data.token); state.editor = true; state.username = data.username; renderEditorState();
      return true;
    } catch (error) {
      if (/Accès mémorisé expiré/.test(error instanceof Error ? error.message : "")) localStorage.removeItem(deviceIdKey);
      return false;
    }
  }
  async function validateCurrentSession() {
    try {
      const data = await request("/session/current");
      state.editor = true; state.username = data.username;
    } catch (error) {
      if (/Accès éditeur requis/.test(error instanceof Error ? error.message : "")) {
        sessionStorage.removeItem(tokenKey); state.editor = false; state.username = "";
        if (!(await restoreRememberedSession())) renderEditorState();
      }
    }
    renderEditorState();
  }
  function cardMarkup(card, index, type) {
    const id = escapeHtml(card.id);
    const preview = markdownPlainText(card.description);
    const description = type === "topic" && preview ? `<p>${escapeHtml(preview)}</p>` : "";
    const author = type === "topic" && card.author ? `<p class="card-author">Par ${escapeHtml(card.author)}</p>` : "";
    const editButton = state.editor ? `<button class="text-button" type="button" data-action="edit-${type}" data-id="${id}">Modifier</button>` : "";
    const removeButton = state.editor ? `<button class="text-button delete-button" type="button" data-action="delete-${type}" data-id="${id}">Supprimer</button>` : "";
    const actions = type === "topic" || state.editor ? `<div class="card-actions">${type === "topic" ? `<button class="text-button" type="button" data-action="open-topic" data-id="${id}">Lire</button>` : ""}${editButton}${removeButton}</div>` : "";
    const href = type === "category" ? categoryPath(card) : topicPath(card);
    return `<article class="card"><a class="card-main" href="${escapeHtml(href)}" data-action="${type === "category" ? "open-category" : "open-topic"}" data-id="${id}"><span class="card-arrow">›</span><h2>${escapeHtml(card.title)}</h2>${description}${author}</a>${actions}</article>`;
  }
  function syncSearchControl() {
    const input = $("[data-search-input]");
    const clearButton = $("[data-action=clear-search]");
    if (input && input.value !== state.search.query) input.value = state.search.query;
    if (clearButton) clearButton.hidden = !state.search.query;
  }
  function renderCategories() {
    const loading = state.loading.categories;
    categoryGrid.hidden = loading;
    categoryGrid.setAttribute("aria-busy", String(loading));
    categoryGrid.innerHTML = state.categories.map((card, index) => cardMarkup(card, index, "category")).join("");
    $("[data-categories-loading]").hidden = !loading;
    $("[data-empty-categories]").hidden = loading || state.categories.length > 0;
  }
  function renderTopics() {
    const loading = state.loading.topics;
    topicGrid.hidden = loading;
    topicGrid.setAttribute("aria-busy", String(loading));
    topicGrid.innerHTML = state.topics.map((card, index) => cardMarkup(card, index, "topic")).join("");
    $("[data-topics-loading]").hidden = !loading;
    const emptyState = $("[data-empty-topics]");
    emptyState.hidden = loading || state.topics.length > 0;
    emptyState.innerHTML = "Aucun sujet ici pour le moment. Utilisez <strong>Ajouter</strong> pour en créer un.";
  }
  function renderSearchResults() {
    const loading = state.search.loading;
    const topics = state.search.topics.filter((card) => matchesSearch(card, state.search.query));
    searchResultsGrid.hidden = loading;
    searchResultsGrid.setAttribute("aria-busy", String(loading));
    searchResultsGrid.innerHTML = topics.map((card, index) => cardMarkup(card, index, "topic")).join("");
    $("[data-search-loading]").hidden = !loading;
    const emptyState = $("[data-empty-search-results]");
    emptyState.hidden = loading || topics.length > 0;
  }
  function renderCurrentView() {
    const isSearching = Boolean(state.search.query.trim());
    searchResultsView.hidden = !isSearching;
    categoriesView.hidden = isSearching || Boolean(state.selected);
    topicsView.hidden = isSearching || !state.selected;
    syncSearchControl();
    if (isSearching) return renderSearchResults();
    if (state.selected) return renderTopics();
    renderCategories();
  }
  function renderEditorState() {
    const connected = state.editor && Boolean(state.username);
    const username = $("[data-connected-user]");
    username.textContent = state.username;
    username.hidden = !connected;
    $("[data-connect-button]").hidden = connected;
    $("[data-user-menu-wrap]").hidden = !connected;
    document.querySelectorAll("[data-action=create-category], [data-action=create-topic]").forEach((button) => { button.hidden = !connected; });
    $("[data-action=edit-detail]").hidden = !connected;
    renderCurrentView();
  }
  function findCard(type, id) {
    const cards = type === "category" ? state.categories : [...state.topics, ...state.search.topics];
    return cards.find((card) => card.id === id);
  }
  function setHome(navigate = true, replace = false) {
    state.routeVersion += 1;
    if (navigate && window.location.pathname !== "/") history[replace ? "replaceState" : "pushState"]({ appRoute: "home" }, "", "/");
    if (detailDialog.open) detailDialog.close();
    state.selected = null; state.topics = []; showNotice(""); renderCurrentView();
  }
  async function loadCategories(render = true) {
    state.loading.categories = true; state.categories = [];
    if (render) renderCurrentView();
    try { state.categories = (await request("/categories")).categories; showNotice(""); }
    catch (error) { state.categories = []; if (apiBase) showNotice(error.message); }
    finally { state.loading.categories = false; }
    if (render) renderCurrentView();
    return state.categories;
  }
  async function openCategory(category, navigate = false, expectedRouteVersion = null) {
    if (!category) return setHome(false);
    const routeVersion = expectedRouteVersion ?? ++state.routeVersion;
    if (navigate) history.pushState({ appRoute: "category" }, "", categoryPath(category));
    if (detailDialog.open) detailDialog.close();
    state.selected = category; state.topics = []; state.loading.topics = true;
    $("[data-topic-title]").textContent = category.title;
    $("[data-topic-description]").innerHTML = renderMarkdown(category.description);
    renderCurrentView();
    try {
      const data = await request(`/topics?categoryId=${encodeURIComponent(category.id)}`);
      if (routeVersion !== state.routeVersion) return;
      state.topics = data.topics; showNotice("");
    }
    catch (error) { if (routeVersion !== state.routeVersion) return; state.topics = []; if (apiBase) showNotice(error.message); }
    finally { if (routeVersion === state.routeVersion) state.loading.topics = false; }
    if (routeVersion === state.routeVersion) renderCurrentView();
  }
  async function updateSearch(query) {
    state.search.query = query;
    if (!query.trim()) { state.search.loading = false; return renderCurrentView(); }
    const requestQuery = query;
    state.search.loading = true; state.search.topics = [];
    renderCurrentView();
    try {
      const data = await request("/topics");
      if (state.search.query !== requestQuery) return;
      state.search.topics = data.topics;
      state.search.loading = false;
      showNotice("");
    } catch (error) {
      if (state.search.query !== requestQuery) return;
      state.search.topics = [];
      state.search.loading = false;
      if (apiBase) showNotice(error.message);
    }
    renderCurrentView();
  }
  function requireEditor(action) {
    showNotice(""); state.pending = action;
    if (state.editor) return openEditor(action);
    openLogin();
  }
  function openLogin() {
    const form = $("[data-access-form]"); form.reset(); form.elements.username.value = localStorage.getItem(usernameKey) || ""; accessDialog.showModal();
  }
  function setUserMenu(open) {
    const button = $("[data-action=toggle-menu]");
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Fermer le menu" : "Ouvrir le menu");
    $("[data-user-menu]").hidden = !open;
  }
  function disconnect(showMessage = true) {
    const deviceId = localStorage.getItem(deviceIdKey);
    if (deviceId && sessionStorage.getItem(tokenKey)) request("/session/remembered", { method: "DELETE", body: JSON.stringify({ deviceId }) }).catch(() => {});
    sessionStorage.removeItem(tokenKey); localStorage.removeItem(deviceIdKey);
    state.editor = false; state.username = ""; setUserMenu(false); renderEditorState();
    if (showMessage) showNotice("Vous êtes déconnecté.");
  }
  function setEditorFeedback(message) { editorFeedback.textContent = message; }
  function descriptionNodeValue(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node;
    if (element.tagName === "IMG") {
      const source = element.getAttribute("data-image-source") || element.getAttribute("src") || "";
      return isEmbeddedImage(source) || isStoredImage(source) ? `![image](${source})` : "";
    }
    if (element.tagName === "BR") return "\n";
    const value = [...element.childNodes].map(descriptionNodeValue).join("");
    return ["DIV", "P"].includes(element.tagName) ? `${value}\n` : value;
  }
  function descriptionFromEditor() { return [...descriptionEditor.childNodes].map(descriptionNodeValue).join("").replace(/\n{3,}/g, "\n\n").trim(); }
  function insertEditorNode(node) {
    const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !descriptionEditor.contains(range.commonAncestorContainer)) descriptionEditor.append(node);
    else {
      range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
    }
    descriptionEditor.focus();
  }
  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Cette image ne peut pas être lue.")); };
      image.src = url;
    });
  }
  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("La compression a échoué.")), "image/webp", quality));
  }
  function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("La lecture de l’image a échoué.")); reader.readAsDataURL(blob); });
  }
  async function compressImage(file) {
    if (file.size > 10 * 1024 * 1024) throw new Error("L’image d’origine est trop volumineuse (10 Mo maximum).");
    const image = await imageFromFile(file); let scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [.82, .68, .55, .42]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= maximumCompressedImageBytes) return dataUrlFromBlob(blob);
      }
      scale *= .75;
    }
    throw new Error("Impossible de compresser suffisamment cette image. Essayez une image plus petite.");
  }
  async function pasteDescription(event) {
    const clipboard = event.clipboardData; const imageItem = [...(clipboard?.items || [])].find((item) => item.kind === "file" && item.type.startsWith("image/"));
    event.preventDefault();
    if (!imageItem) return insertEditorNode(document.createTextNode(clipboard?.getData("text/plain") || ""));
    if (descriptionEditor.querySelectorAll("img").length >= maximumEmbeddedImages) return setEditorFeedback("Dix images maximum par description.");
    const file = imageItem.getAsFile(); if (!file) return setEditorFeedback("Cette image ne peut pas être utilisée.");
    setEditorFeedback("Compression de l’image…");
    try {
      const source = await compressImage(file); const image = document.createElement("img");
      image.src = source; image.dataset.imageSource = source; image.dataset.action = "expand-image"; image.alt = "Illustration ajoutée"; insertEditorNode(image);
      setEditorFeedback("Image ajoutée et compressée.");
    } catch (error) { setEditorFeedback(error instanceof Error ? error.message : "La compression a échoué."); }
  }
  async function uploadPastedImages(description) {
    const images = [...description.matchAll(/!\[image\]\((data:image\/webp;base64,[A-Za-z0-9+/=]+)\)/g)];
    let uploaded = description;
    for (const image of images) {
      const data = await request("/uploads/images", { method: "POST", body: JSON.stringify({ source: image[1] }) });
      uploaded = uploaded.replace(image[0], `![image](${data.source})`);
    }
    return uploaded;
  }
  async function uploadPdf(event) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setEditorFeedback("Sélectionnez un fichier PDF.");
    if (file.size > maximumPdfBytes) return setEditorFeedback("Le PDF est trop volumineux (10 Mo maximum).");
    const submit = $("[data-editor-form]").querySelector("button[type=submit]"); submit.disabled = true; setEditorFeedback("Import du PDF…");
    try {
      const response = await fetch(apiUrl("/uploads/documents"), { method: "POST", headers: { Authorization: `Bearer ${sessionStorage.getItem(tokenKey) || ""}`, "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) }, body: file });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "L’import du PDF a échoué.");
      insertEditorNode(document.createTextNode(`[${data.filename}](${data.source})`)); setEditorFeedback("PDF ajouté à la description.");
    } catch (error) { setEditorFeedback(error instanceof Error ? error.message : "L’import du PDF a échoué."); }
    finally { submit.disabled = false; }
  }
  function openEditor(action) {
    state.editorForm = action;
    const form = $("[data-editor-form]");
    $("[data-editor-title]").textContent = action.mode === "edit" ? "Modifier la carte" : "Nouvelle carte";
    form.title.value = action.card?.title || "";
    const authorField = $("[data-author-field]"); authorField.hidden = action.kind !== "topic";
    form.author.value = action.kind === "topic" ? (action.card?.author || (action.mode === "create" ? localStorage.getItem(authorKey) || "" : "")) : "";
    descriptionEditor.innerHTML = renderEditorDescription(action.card?.description || "");
    setEditorFeedback("");
    editorDialog.showModal();
  }
  function openTopic(topic, navigate = false) {
    if (!topic) return;
    if (navigate) {
      const path = topicPath(topic);
      if (path !== "/") history.pushState({ appRoute: "topic", parentPath: window.location.pathname }, "", path);
    }
    state.detail = topic; $("[data-detail-title]").textContent = topic.title;
    const author = $("[data-detail-author]"); author.hidden = !topic.author; author.textContent = topic.author ? `Par ${topic.author}` : "";
    $("[data-detail-copy]").innerHTML = renderMarkdown(topic.description); detailDialog.showModal();
  }
  async function routeFromLocation(initial = false) {
    const routeVersion = ++state.routeVersion;
    let segments;
    try { segments = window.location.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
    catch { segments = []; }
    if (detailDialog.open) detailDialog.close();
    if (!segments.length) {
      state.selected = null; state.topics = []; showNotice(""); renderCurrentView();
      if (initial) history.replaceState({ appRoute: "home" }, "", "/");
      return;
    }
    const category = state.categories.find((item) => cardSlug(item) === segments[0]);
    if (!category || segments.length > 2) {
      history.replaceState({ appRoute: "home" }, "", "/");
      state.selected = null; state.topics = []; showNotice("Cette page est introuvable."); renderCurrentView();
      return;
    }
    const categoryUrl = categoryPath(category);
    if (initial && segments.length === 1) history.replaceState({ appRoute: "category" }, "", categoryUrl);
    await openCategory(category, false, routeVersion);
    if (routeVersion !== state.routeVersion || segments.length === 1) return;
    const topic = state.topics.find((item) => cardSlug(item) === segments[1]);
    if (!topic) {
      history.replaceState({ appRoute: "category" }, "", categoryUrl);
      showNotice("Ce sujet est introuvable."); renderCurrentView();
      return;
    }
    const topicUrl = topicPath(topic);
    if (initial) {
      history.replaceState({ appRoute: "category" }, "", categoryUrl);
      history.pushState({ appRoute: "topic", parentPath: categoryUrl }, "", topicUrl);
    } else if (window.location.pathname !== topicUrl) history.replaceState({ appRoute: "topic", parentPath: categoryUrl }, "", topicUrl);
    openTopic(topic);
  }
  detailDialog.addEventListener("close", () => {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return;
    const parentPath = history.state?.appRoute === "topic" ? history.state.parentPath : "";
    if (parentPath) history.back();
    else {
      const category = state.categories.find((item) => cardSlug(item) === segments[0]);
      const categoryUrl = category ? categoryPath(category) : "/";
      history.replaceState({ appRoute: category ? "category" : "home" }, "", categoryUrl);
      void routeFromLocation();
    }
  });
  async function unlock(event) {
    event.preventDefault();
    const form = event.currentTarget; const submit = form.querySelector("button[type=submit]"); submit.disabled = true;
    try {
      const username = form.elements.username.value.trim();
      const deviceId = localStorage.getItem(deviceIdKey) || crypto.randomUUID();
      const data = await request("/session", { method: "POST", body: JSON.stringify({ code: form.elements["access-code"].value, username, deviceId }) });
      sessionStorage.setItem(tokenKey, data.token); localStorage.setItem(deviceIdKey, deviceId); localStorage.setItem(usernameKey, data.username);
      state.editor = true; state.username = data.username; renderEditorState(); accessDialog.close();
      if (state.pending) openEditor(state.pending);
    } catch (error) { showNotice(error.message); }
    finally { submit.disabled = false; }
  }
  async function saveCard(event) {
    event.preventDefault();
    const action = state.editorForm; if (!action) return;
    const form = event.currentTarget; const submit = form.querySelector("button[type=submit]"); submit.disabled = true;
    let description = descriptionFromEditor();
    if (!description && action.kind === "topic") { showNotice("Une description ou une image est requise."); submit.disabled = false; return; }
    const base = action.kind === "topic" ? "/topics" : "/categories";
    const url = action.mode === "edit" ? `${base}/${encodeURIComponent(action.card.id)}` : base;
    try {
      description = await uploadPastedImages(description);
      const author = form.author.value.trim();
      const payload = { title: form.title.value, description, ...(action.kind === "topic" ? { categoryId: action.categoryId, author } : {}) };
      await request(url, { method: action.mode === "edit" ? "PUT" : "POST", body: JSON.stringify(payload) });
      if (action.kind === "topic" && author) localStorage.setItem(authorKey, author);
      editorDialog.close();
      if (action.kind === "category") { await loadCategories(); if (state.selected) await openCategory(state.categories.find((item) => item.id === state.selected.id) || state.selected); }
      else if (state.search.query.trim()) await updateSearch(state.search.query);
      else if (state.selected) await openCategory(state.selected);
    } catch (error) {
      if (/Accès éditeur requis/.test(error.message)) {
        sessionStorage.removeItem(tokenKey); state.editor = false; state.username = "";
        if (await restoreRememberedSession()) { editorDialog.close(); openEditor(action); }
        else { localStorage.removeItem(deviceIdKey); renderEditorState(); editorDialog.close(); requireEditor(action); }
      }
      else showNotice(error.message);
    } finally { submit.disabled = false; }
  }
  async function deleteCard(kind, id) {
    const subject = kind === "category" ? "cette catégorie et tous ses sujets" : "ce sujet";
    if (!window.confirm(`Supprimer ${subject} ? Cette action est définitive.`)) return;
    const base = kind === "category" ? "/categories" : "/topics";
    try {
      await request(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (kind === "category") {
        if (state.selected?.id === id) setHome();
        await loadCategories();
      } else if (state.search.query.trim()) await updateSearch(state.search.query);
      else if (state.selected) await openCategory(state.selected);
    } catch (error) {
      if (/Accès éditeur requis/.test(error.message)) {
        sessionStorage.removeItem(tokenKey); state.editor = false; state.username = "";
        if (await restoreRememberedSession()) {
          try {
            await request(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
            if (kind === "category") { if (state.selected?.id === id) setHome(); await loadCategories(); }
            else if (state.search.query.trim()) await updateSearch(state.search.query);
            else if (state.selected) await openCategory(state.selected);
          } catch (retryError) { showNotice(retryError.message); }
        } else {
          localStorage.removeItem(deviceIdKey); renderEditorState(); showNotice("Votre session a expiré. Connectez-vous à nouveau pour continuer.");
        }
      } else showNotice(error.message);
    }
  }
  function setTheme(theme, persist = true) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "";
    const themeToggle = $("[data-action=toggle-theme]");
    const nextThemeLabel = isDark ? "Activer le mode clair" : "Activer le mode sombre";
    themeToggle.setAttribute("aria-label", nextThemeLabel);
    themeToggle.title = isDark ? "Mode clair" : "Mode sombre";
    $("[data-theme-icon]").textContent = isDark ? "☀" : "☾";
    if (persist) localStorage.setItem(themeKey, isDark ? "dark" : "light");
  }
  function toggleTheme() { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }
  function openExpandedImage(source) {
    if (!isEmbeddedImage(source) && !isStoredImage(source)) return;
    $("[data-expanded-image]").src = imageUrl(source); imageDialog.showModal();
  }
  function actionFromElement(event) {
    const target = event.target;
    const element = target instanceof Element ? target : target?.parentElement;
    const button = element?.closest("[data-action]"); if (!button) return;
    if (button instanceof HTMLAnchorElement) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
    }
    const { action, id } = button.dataset;
    if (action === "toggle-theme") return toggleTheme();
    if (action === "toggle-menu") return setUserMenu($("[data-user-menu]").hidden);
    if (action === "open-login") { state.pending = null; return openLogin(); }
    if (action === "disconnect") return disconnect();
    if (action === "expand-image") return openExpandedImage(button.dataset.imageSource || "");
    if (action === "clear-search") return updateSearch("");
    if (action === "home") return setHome();
    if (action === "create-category") return requireEditor({ kind: "category", mode: "create" });
    if (action === "create-topic") return requireEditor({ kind: "topic", mode: "create", categoryId: state.selected.id });
    if (action === "upload-pdf") return $("[data-pdf-upload]").click();
    if (action === "open-category") return openCategory(findCard("category", id), true);
    if (action === "open-topic") return openTopic(findCard("topic", id), true);
    if (action === "edit-category") return requireEditor({ kind: "category", mode: "edit", card: findCard("category", id) });
    if (action === "edit-topic") { const topic = findCard("topic", id); detailDialog.close(); return requireEditor({ kind: "topic", mode: "edit", card: topic, categoryId: topic.categoryId }); }
    if (action === "delete-category") return deleteCard("category", id);
    if (action === "delete-topic") return deleteCard("topic", id);
    if (action === "edit-detail") { detailDialog.close(); return requireEditor({ kind: "topic", mode: "edit", card: state.detail, categoryId: state.detail.categoryId }); }
  }
  document.addEventListener("click", actionFromElement);
  document.addEventListener("click", (event) => { if (!(event.target instanceof Element) || !event.target.closest("[data-user-menu-wrap]")) setUserMenu(false); });
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  window.addEventListener("popstate", () => { void routeFromLocation(); });
  $("[data-search-input]").addEventListener("input", (event) => updateSearch(event.currentTarget.value));
  $("[data-access-form]").addEventListener("submit", unlock);
  $("[data-editor-form]").addEventListener("submit", saveCard);
  $("[data-pdf-upload]").addEventListener("change", uploadPdf);
  descriptionEditor.addEventListener("paste", pasteDescription);
  setTheme(localStorage.getItem(themeKey) === "dark" ? "dark" : "light", false);
  renderEditorState(); loadCategories(false).then(() => routeFromLocation(true));
  if (sessionStorage.getItem(tokenKey)) validateCurrentSession();
  else restoreRememberedSession();
})();
