// ============================================================
//  API do Catálogo de Pratas
//  - Guarda as peças no MongoDB Atlas (gratuito, permanente)
//  - Guarda as fotos no Cloudinary (gratuito, permanente)
//  - O painel admin (admin.html) e o catálogo do cliente (cliente.html)
//    conversam com essa API pra sempre verem os mesmos dados.
//
//  Por que essa versão existe:
//  No plano gratuito do Render, qualquer arquivo salvo localmente
//  (banco de dados em arquivo, fotos numa pasta) é apagado sempre que
//  o serviço reinicia. Por isso agora os dados ficam guardados em
//  serviços externos feitos pra isso, que não se apagam nunca.
//
//  Variáveis de ambiente necessárias (configuradas no Render, em
//  Settings → Environment, NÃO direto no código):
//    MONGODB_URI            -> string de conexão do MongoDB Atlas
//    CLOUDINARY_CLOUD_NAME  -> nome da conta Cloudinary
//    CLOUDINARY_API_KEY     -> chave de API do Cloudinary
//    CLOUDINARY_API_SECRET  -> segredo de API do Cloudinary
//
//  Como rodar localmente:
//    1) npm install
//    2) crie um arquivo .env nesta pasta com as 4 variáveis acima
//    3) npm start
//    4) Abra admin.html para cadastrar peças
//       e cliente.html para ver o catálogo
// ============================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const PORT = process.env.PORT || 3001;
const ROOT = __dirname;

// ---------- VALIDAÇÃO DE CONFIGURAÇÃO ----------
const VARS_OBRIGATORIAS = ['MONGODB_URI', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const faltando = VARS_OBRIGATORIAS.filter(v => !process.env[v]);
if (faltando.length > 0) {
  console.error('');
  console.error('  ERRO: faltam variáveis de ambiente obrigatórias:');
  faltando.forEach(v => console.error('   - ' + v));
  console.error('');
  console.error('  Configure-as em Render → seu serviço → Settings → Environment');
  console.error('  (ou em um arquivo .env se estiver rodando localmente).');
  console.error('');
  process.exit(1);
}

// ---------- CLOUDINARY (armazenamento de fotos) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function enviarFotoParaCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'catalogo-pratas' },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

function extrairPublicIdDaUrl(url) {
  // Extrai o "public_id" do Cloudinary a partir da URL completa, para
  // conseguir apagar a foto quando a peça for removida ou editada.
  // Ex.: https://res.cloudinary.com/xxx/image/upload/v123/catalogo-pratas/abc123.jpg
  //   -> catalogo-pratas/abc123
  try {
    const semQuery = url.split('?')[0];
    const partes = semQuery.split('/upload/')[1]; // "v123/catalogo-pratas/abc123.jpg"
    if (!partes) return null;
    const semVersao = partes.replace(/^v\d+\//, ''); // remove "v123/"
    const semExtensao = semVersao.replace(/\.[a-zA-Z0-9]+$/, ''); // remove ".jpg"
    return semExtensao;
  } catch (e) {
    return null;
  }
}

async function removerFotoDoCloudinary(url) {
  const publicId = extrairPublicIdDaUrl(url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.error('Aviso: não foi possível remover foto antiga do Cloudinary:', e.message);
  }
}

// ---------- MONGODB ATLAS (armazenamento dos dados) ----------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('  Conectado ao MongoDB Atlas com sucesso.'))
  .catch(err => {
    console.error('  ERRO ao conectar ao MongoDB:', err.message);
    process.exit(1);
  });

const produtoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  preco: { type: Number, required: true },
  categoria: { type: String, required: true },
  fotos: { type: [String], default: [] }, // URLs do Cloudinary
  criado_em: { type: Date, default: Date.now }
});

const Produto = mongoose.model('Produto', produtoSchema);

// ---------- APP ----------
const app = express();
app.set('trust proxy', true); // necessário para detectar https corretamente em hospedagens como Render
app.use(cors());
app.use(express.json());

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

// ---------- UPLOAD (em memória, depois enviado direto pro Cloudinary) ----------
const TIPOS_PERMITIDOS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const upload = multer({
  storage: multer.memoryStorage(),
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
app.get('/api/produtos', async (req, res) => {
  try {
    const produtos = await Produto.find().sort({ _id: -1 });
    res.json(produtos.map(formatarProduto));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar peças.' });
  }
});

// Cria uma nova peça (usado pelo admin) — exige exatamente 4 fotos
app.post('/api/produtos', uploadFotos, async (req, res) => {
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
      return res.status(400).json({ erro: 'Envie exatamente 4 fotos para a peça.' });
    }

    // envia as 4 fotos para o Cloudinary em paralelo
    const fotosUrls = await Promise.all(
      arquivos.map(f => enviarFotoParaCloudinary(f.buffer))
    );

    const novo = await Produto.create({
      nome: nome.trim(),
      preco: precoNum,
      categoria: categoria.trim(),
      fotos: fotosUrls
    });

    res.status(201).json(formatarProduto(novo));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message || 'Erro ao salvar a peça.' });
  }
});

// Remove uma peça (usado pelo admin)
app.delete('/api/produtos/:id', async (req, res) => {
  try {
    const existente = await Produto.findById(req.params.id);
    if (!existente) {
      return res.status(404).json({ erro: 'Peça não encontrada.' });
    }

    // remove as fotos do Cloudinary também, para não acumular lixo lá
    await Promise.all((existente.fotos || []).map(removerFotoDoCloudinary));

    await Produto.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ erro: 'Peça não encontrada.' });
  }
});

// Edita uma peça existente (usado pelo admin).
// Pode enviar de 0 a 4 novas fotos no campo "fotos" — as fotos enviadas
// substituem as fotos antigas NA MESMA POSIÇÃO (1ª enviada substitui a 1ª etc.).
// Se não enviar nenhuma foto nova, mantém todas as 4 fotos atuais.
app.put('/api/produtos/:id', uploadFotos, async (req, res) => {
  try {
    const existente = await Produto.findById(req.params.id);
    if (!existente) {
      return res.status(404).json({ erro: 'Peça não encontrada.' });
    }

    const { nome, preco, categoria } = req.body;
    const arquivosNovos = (req.files && req.files['fotos']) || [];

    let fotosAtuais = existente.fotos.slice();

    if (arquivosNovos.length > 0) {
      const novasUrls = await Promise.all(
        arquivosNovos.map(f => enviarFotoParaCloudinary(f.buffer))
      );
      for (let i = 0; i < novasUrls.length; i++) {
        const antiga = fotosAtuais[i];
        if (antiga) await removerFotoDoCloudinary(antiga);
        fotosAtuais[i] = novasUrls[i];
      }
    }

    existente.nome = nome !== undefined ? nome.trim() : existente.nome;
    existente.preco = preco !== undefined ? parseFloat(preco) : existente.preco;
    existente.categoria = categoria !== undefined ? categoria.trim() : existente.categoria;
    existente.fotos = fotosAtuais;
    await existente.save();

    res.json(formatarProduto(existente));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message || 'Erro ao editar a peça.' });
  }
});

// Verificação simples de que a API está no ar (útil para debug)
app.get('/api/status', async (req, res) => {
  try {
    const total = await Produto.countDocuments();
    res.json({ ok: true, total_produtos: total });
  } catch (err) {
    res.status(500).json({ ok: false, erro: 'Erro ao consultar o banco de dados.' });
  }
});

function formatarProduto(row) {
  return {
    id: row._id.toString(),
    nome: row.nome,
    preco: row.preco,
    categoria: row.categoria,
    fotos: row.fotos || [],
    // mantém "foto" (primeira da lista) por compatibilidade com qualquer
    // código antigo que ainda espere esse campo
    foto: (row.fotos && row.fotos[0]) || null,
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
  console.log('   Fotos: Cloudinary | Dados: MongoDB Atlas');
  console.log('  ===========================================');
  console.log('');
  console.log('  Local: abra admin.html para cadastrar peças');
  console.log('  e cliente.html para ver o catálogo.');
  console.log('');
});
