// ============================================================
//  API do Catálogo de Pratas
//  - Guarda as peças num arquivo de banco de dados local (catalogo.json)
//  - Guarda as fotos na pasta /uploads
//  - O painel admin (admin.html) e o catálogo do cliente (cliente.html)
//    conversam com essa API pra sempre verem os mesmos dados.
//
//  Como rodar:
//    1) npm install
//    2) npm start
//    3) Abra admin.html no navegador para cadastrar peças
//    4) Abra cliente.html no navegador para ver o catálogo do jeito
//       que o cliente vai ver
//
//  OBS: esta versão guarda os dados em um arquivo catalogo.json
//  (em vez de um banco SQLite) para não exigir nenhuma ferramenta
//  de compilação (Python, Visual Studio, etc.) na máquina do usuário.
//  Funciona igual, do ponto de vista do admin.html e cliente.html.
// ============================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// PORT: em hospedagens como o Render, a porta é definida automaticamente
// pela variável de ambiente PORT. Localmente, cai para 3001 como antes.
const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DB_PATH = path.join(ROOT, 'catalogo.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- "BANCO DE DADOS" (arquivo JSON simples) ----------
// Estrutura: { nextId: number, produtos: [ {id, nome, preco, categoria, foto, criado_em} ] }

function lerBanco() {
  if (!fs.existsSync(DB_PATH)) {
    return { nextId: 1, produtos: [] };
  }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    if (!raw.trim()) return { nextId: 1, produtos: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.produtos)) data.produtos = [];
    if (typeof data.nextId !== 'number') data.nextId = 1;
    return data;
  } catch (e) {
    console.error('Aviso: catalogo.json estava corrompido, recriando vazio.', e.message);
    return { nextId: 1, produtos: [] };
  }
}

function salvarBanco(data) {
  // escreve em arquivo temporário e renomeia, para evitar corromper o
  // catalogo.json se a gravação for interrompida no meio
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}

// ---------- APP ----------
const app = express();
app.set('trust proxy', true); // necessário para detectar https corretamente em hospedagens como Render
app.use(cors());
app.use(express.json());

// serve as fotos enviadas: /uploads/arquivo.jpg
app.use('/uploads', express.static(UPLOADS_DIR));

// Serve o catálogo público (cliente.html) na raiz do site.
// O admin.html NÃO é servido aqui de propósito — ele continua sendo
// usado só localmente, no seu computador, para que estranhos não
// consigam achar o painel de cadastro pelo link público.
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'cliente.html'));
});
app.get('/cliente.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'cliente.html'));
});

// ---------- UPLOAD DE FOTO ----------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const nomeUnico = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    cb(null, nomeUnico);
  }
});

const TIPOS_PERMITIDOS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB por foto
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (TIPOS_PERMITIDOS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use JPG, PNG, WEBP ou GIF.'));
    }
  }
});

// cada peça tem até 4 fotos, enviadas no campo "fotos" (múltiplos arquivos)
const uploadFotos = upload.fields([{ name: 'fotos', maxCount: 4 }]);

// ============================================================
// ROTAS
// ============================================================

// Lista todas as peças (usado pelo catálogo do cliente e pelo admin)
app.get('/api/produtos', (req, res) => {
  const data = lerBanco();
  const produtos = data.produtos
    .slice()
    .sort((a, b) => b.id - a.id)
    .map(p => formatarProduto(p, req));
  res.json(produtos);
});

// Cria uma nova peça (usado pelo admin) — exige exatamente 4 fotos
app.post('/api/produtos', uploadFotos, (req, res) => {
  try {
    const { nome, preco, categoria } = req.body;
    const arquivos = (req.files && req.files['fotos']) || [];

    if (!nome || !nome.trim()) {
      return res.status(400).json({ erro: 'O nome da peça é obrigatório.' });
    }
    const precoNum = parseFloat(preco);
    if (isNaN(precoNum) || precoNum < 0) {
      return res.status(400).json({ erro: 'Informe um preço válido.' });
    }
    if (!categoria || !categoria.trim()) {
      return res.status(400).json({ erro: 'A categoria é obrigatória.' });
    }
    if (arquivos.length !== 4) {
      // remove qualquer arquivo que já tenha sido salvo no disco antes da validação falhar
      arquivos.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ erro: 'Envie exatamente 4 fotos para a peça.' });
    }

    const fotosUrls = arquivos.map(f => `/uploads/${f.filename}`);

    const data = lerBanco();
    const novo = {
      id: data.nextId,
      nome: nome.trim(),
      preco: precoNum,
      categoria: categoria.trim(),
      fotos: fotosUrls,
      criado_em: new Date().toISOString()
    };
    data.nextId += 1;
    data.produtos.push(novo);
    salvarBanco(data);

    res.status(201).json(formatarProduto(novo, req));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message || 'Erro ao salvar a peça.' });
  }
});

// Remove uma peça (usado pelo admin)
app.delete('/api/produtos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const data = lerBanco();
  const idx = data.produtos.findIndex(p => p.id === id);

  if (idx === -1) {
    return res.status(404).json({ erro: 'Peça não encontrada.' });
  }

  const existente = data.produtos[idx];

  // remove todos os arquivos de foto do disco (campo novo "fotos", lista)
  const listaFotos = existente.fotos || (existente.foto ? [existente.foto] : []);
  listaFotos.forEach(f => {
    const caminhoFoto = path.join(ROOT, f);
    fs.unlink(caminhoFoto, () => {}); // ignora erro se não existir
  });

  data.produtos.splice(idx, 1);
  salvarBanco(data);

  res.json({ ok: true });
});

// Edita uma peça existente (usado pelo admin).
// Pode enviar de 0 a 4 novas fotos no campo "fotos" — as fotos enviadas
// substituem as fotos antigas NA MESMA POSIÇÃO (1ª enviada substitui a 1ª etc.).
// Se não enviar nenhuma foto nova, mantém todas as 4 fotos atuais.
app.put('/api/produtos/:id', uploadFotos, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const data = lerBanco();
  const idx = data.produtos.findIndex(p => p.id === id);

  if (idx === -1) {
    return res.status(404).json({ erro: 'Peça não encontrada.' });
  }

  const existente = data.produtos[idx];
  const { nome, preco, categoria } = req.body;
  const precoNum = preco !== undefined ? parseFloat(preco) : existente.preco;

  let fotosAtuais = existente.fotos || (existente.foto ? [existente.foto] : []);
  const arquivosNovos = (req.files && req.files['fotos']) || [];

  if (arquivosNovos.length > 0) {
    // substitui as fotos antigas, na ordem, pelas novas enviadas
    arquivosNovos.forEach((f, i) => {
      const antiga = fotosAtuais[i];
      if (antiga) fs.unlink(path.join(ROOT, antiga), () => {});
      fotosAtuais[i] = `/uploads/${f.filename}`;
    });
  }

  const atualizado = {
    ...existente,
    nome: nome !== undefined ? nome.trim() : existente.nome,
    preco: precoNum,
    categoria: categoria !== undefined ? categoria.trim() : existente.categoria,
    fotos: fotosAtuais
  };
  delete atualizado.foto; // remove campo antigo, se existia

  data.produtos[idx] = atualizado;
  salvarBanco(data);

  res.json(formatarProduto(atualizado, req));
});

// Verificação simples de que a API está no ar (útil para debug)
app.get('/api/status', (req, res) => {
  const data = lerBanco();
  res.json({ ok: true, total_produtos: data.produtos.length });
});

function formatarProduto(row, req) {
  const protocolo = req.protocol;
  const host = req.get('host');

  // retrocompatibilidade: peças antigas tinham um campo "foto" único.
  // Peças novas têm "fotos" (lista de até 4).
  const listaFotos = row.fotos || (row.foto ? [row.foto] : []);
  const fotosCompletas = listaFotos.map(f => `${protocolo}://${host}${f}`);

  return {
    id: row.id,
    nome: row.nome,
    preco: row.preco,
    categoria: row.categoria,
    fotos: fotosCompletas,
    // mantém "foto" (primeira da lista) por compatibilidade com qualquer
    // código antigo que ainda espere esse campo
    foto: fotosCompletas[0] || null,
    criado_em: row.criado_em
  };
}

// tratamento de erro do multer (ex: arquivo grande demais)
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ erro: err.message || 'Erro no upload do arquivo.' });
  }
  next();
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ===========================================');
  console.log('   API do Catálogo de Pratas rodando!');
  console.log('   Porta: ' + PORT);
  console.log('  ===========================================');
  console.log('');
  console.log('  Local: abra admin.html para cadastrar peças');
  console.log('  e cliente.html para ver o catálogo.');
  console.log('');
});
