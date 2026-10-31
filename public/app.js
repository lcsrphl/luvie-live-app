
const auth = firebase.auth();
const db = firebase.firestore();

const el = id => document.getElementById(id);

let items = [];

function msg(text, error = false) {
  el("message").textContent = text;
  el("message").className = error ? "error" : "ok";
}

const brl = n =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(n);

// Lê os dados do arquivo TXT
function parseTXT(txt) {
  const blocks = txt
    .replace(/\r/g, "")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\n\s*\n/);

  const seen = new Set();
  const result = [];
  const issues = [];

  for (const [i, block] of blocks.entries()) {
    if (!block.trim()) continue;

    const lines = block.split("\n");

    const get = key => {
      const match = lines.find(l =>
        l.trim().toLowerCase().startsWith(key + ":")
      );

      return match
        ? match.slice(match.indexOf(":") + 1).trim()
        : "";
    };

    const codigo = get("código") || get("codigo");
    const descricao = get("descrição") || get("descricao");
    const raw = get("preço") || get("preco");

    const cleaned = raw
      .replace(/R\$|\s|\./gi, "")
      .replace(",", ".");

    const preco = Number(cleaned);

    if (
      !/^\d+$/.test(codigo) ||
      !descricao ||
      !raw ||
      !Number.isFinite(preco) ||
      preco <= 0
    ) {
      issues.push(
        "Bloco " + (i + 1) +
        ": código, descrição ou preço inválido"
      );
      continue;
    }

    if (seen.has(codigo)) {
      issues.push("Código repetido no TXT: " + codigo);
      continue;
    }

    seen.add(codigo);

    result.push({
      codigo,
      descricao,
      preco,
      quantidade: 1,
      status: "disponivel"
    });
  }

  return { result, issues };
}

// Mostra as peças na tela
function render() {
  el("preview").replaceChildren();

  el("count").textContent = items.length + " peças válidas";

  el("total").textContent = brl(
    items.reduce((n, p) => n + p.preco, 0)
  );

  items.forEach(p => {
    const row = document.createElement("div");
    row.className = "row";

    const left = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent = p.codigo + " · " + p.descricao;

    const detail = document.createElement("small");
    detail.textContent = "Quantidade: 1";

    const price = document.createElement("span");
    price.className = "price";
    price.textContent = brl(p.preco);

    left.append(title, detail);
    row.append(left, price);
    el("preview").append(row);
  });

  el("save").disabled = !items.length;
}

// Seleciona e lê o TXT
el("file").addEventListener("change", async e => {
  const f = e.target.files?.[0];
  if (!f) return;

  try {
    const { result, issues } = parseTXT(await f.text());

    items = issues.length ? [] : result;
    render();

    msg(
      issues.length
        ? "Corrija o TXT antes de importar:\n" +
          issues.join("\n")
        : "Arquivo lido! Confira as peças antes de cadastrar.",
      !!issues.length
    );
  } catch (err) {
    items = [];
    render();
    msg("Não foi possível ler o arquivo: " + err.message, true);
  }
});

// Limpa a lista
el("clear").onclick = () => {
  items = [];
  el("file").value = "";
  render();
  msg("Lista limpa.");
};

// Login
el("login").onclick = async () => {
  try {
    await auth.signInWithEmailAndPassword(
      el("email").value.trim(),
      el("password").value
    );

    msg("Login realizado.");
  } catch (err) {
    msg("Erro ao entrar: " + err.message, true);
  }
};

// Logout
el("logout").onclick = () => auth.signOut();

// Verifica usuário autenticado
auth.onAuthStateChanged(user => {
  el("loginCard").classList.toggle("hidden", !!user);
  el("appCard").classList.toggle("hidden", !user);
  el("userLabel").textContent = user?.email || "";
});

// Salva os produtos no Firestore
el("save").onclick = async () => {
  if (!auth.currentUser) {
    msg("Faça login primeiro.", true);
    return;
  }

  if (!items.length) return;

  el("save").disabled = true;
  msg("Conferindo códigos existentes...");

  try {
    const refs = items.map(p =>
      db.collection("products").doc(p.codigo)
    );

    const existing = await Promise.all(
      refs.map(ref => ref.get())
    );

    const repeated = existing
      .filter(s => s.exists)
      .map(s => s.id);

    if (repeated.length) {
      throw new Error(
        "Já existem peças cadastradas com os códigos: " +
        repeated.join(", ") +
        ". Nada foi sobrescrito."
      );
    }

    const batch = db.batch();

    for (let i = 0; i < items.length; i++) {
      batch.set(refs[i], {
        ...items[i],
        criadoEm:
          firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();

    msg(
      items.length +
      " peças cadastradas com sucesso no Firestore!"
    );

    items = [];
    el("file").value = "";
    render();

  } catch (err) {
    msg("Não foi possível cadastrar: " + err.message, true);
    el("save").disabled = false;
  }
};
