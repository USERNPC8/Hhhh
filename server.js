const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'temp/' });

// --- CORREÇÃO PARA WINDOWS VS LINUX ---
// Se estiver no Windows, usa o named pipe. Se for Linux/Mac, usa o socket unix.
const dockerSocket = process.platform === 'win32' 
    ? '//./pipe/docker_engine' 
    : '/var/run/docker.sock';

const docker = new Docker({ socketPath: dockerSocket });

app.use(express.static('public'));
app.use(express.json());

// Garante pastas
fs.ensureDirSync(path.join(__dirname, 'bots'));
fs.ensureDirSync(path.join(__dirname, 'temp'));

// Monitoramento de Logs
function attachLogStream(container, botId) {
    container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err) return;
        stream.on('data', (chunk) => {
            // Remove cabeçalhos binários do Docker para deixar o texto limpo
            let log = chunk.toString('utf8');
            // Regex leve para limpar caracteres estranhos do docker stream
            log = log.replace(/[\x00-\x09\x0B-\x1F\x7F]\[.*?m/g, ''); 
            io.to(botId).emit('new-log', log.substring(8)); // Pula os 8 bytes de header
        });
    });
}

app.post('/deploy', upload.single('botFile'), async (req, res) => {
    const botName = req.body.botName.replace(/[^a-z0-9-]/g, '');
    if (!botName) return res.status(400).json({ error: "Nome inválido." });

    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, 'bots', botName);

    try {
        // 1. Limpeza
        if (fs.existsSync(extractPath)) await fs.remove(extractPath);
        try {
            const oldContainer = docker.getContainer(botName);
            await oldContainer.stop();
            await oldContainer.remove();
        } catch (e) {}

        // 2. Extração
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);
        fs.unlinkSync(zipPath);

        // 3. Validação (Importante: Verifica se o package.json está na raiz ou dentro de subpasta)
        let workDir = extractPath;
        if (!fs.existsSync(path.join(extractPath, 'package.json'))) {
            // Tenta achar dentro da primeira subpasta (caso o usuario tenha zipado a pasta e não os arquivos)
            const files = fs.readdirSync(extractPath);
            if (files.length === 1 && fs.lstatSync(path.join(extractPath, files[0])).isDirectory()) {
                workDir = path.join(extractPath, files[0]);
            } else {
                return res.status(400).json({ error: 'Erro: package.json não encontrado! Zipe os arquivos, não a pasta.' });
            }
        }

        // 4. Container
        const container = await docker.createContainer({
            Image: 'node:18-alpine',
            name: botName,
            Cmd: ['sh', '-c', 'npm install && npm start'],
            HostConfig: {
                Binds: [`${workDir}:/app`],
                WorkingDir: '/app',
                Memory: 512 * 1024 * 1024,
                NanoCpus: 1000000000
            }
        });

        await container.start();
        attachLogStream(container, botName);

        res.json({ success: true, botId: botName });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

io.on('connection', (socket) => {
    socket.on('watch-bot', (botId) => socket.join(botId));
});

server.listen(3000, () => {
    console.log('✅ Sistema Online: http://localhost:3000');
    console.log(`🔧 Docker Socket: ${dockerSocket}`);
});
