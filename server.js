const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');

// Configuração Inicial
const app = express();
const server = http.createServer(app);
const io = new Server(server); // WebSockets para logs em tempo real
const docker = new Docker({ socketPath: '/var/run/docker.sock' }); // Windows/Linux padrão
const upload = multer({ dest: 'temp/' });

app.use(express.static('public'));
app.use(express.json());

// Garante que as pastas existem
fs.ensureDirSync(path.join(__dirname, 'bots'));
fs.ensureDirSync(path.join(__dirname, 'temp'));

// --- FUNÇÃO: Monitorar Logs em Tempo Real ---
function attachLogStream(container, botId) {
    container.logs({
        follow: true,
        stdout: true,
        stderr: true
    }, (err, stream) => {
        if (err) return;
        // Quando o container "falar" algo, enviamos para o site via Socket
        stream.on('data', (chunk) => {
            // Limpeza básica de caracteres de controle do Docker
            const logClean = chunk.toString('utf8').substring(8); 
            io.to(botId).emit('new-log', logClean);
        });
    });
}

// --- ROTA: Upload e Deploy ---
app.post('/deploy', upload.single('botFile'), async (req, res) => {
    const botName = req.body.botName.replace(/[^a-z0-9-]/g, ''); // Sanitiza nome
    if(!botName) return res.status(400).json({error: "Nome inválido"});

    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, 'bots', botName);

    try {
        // 1. Limpar instalação anterior
        if (fs.existsSync(extractPath)) {
            await fs.remove(extractPath);
            try {
                const oldContainer = docker.getContainer(botName);
                await oldContainer.stop();
                await oldContainer.remove();
            } catch (e) {}
        }

        // 2. Extrair ZIP
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);
        fs.unlinkSync(zipPath);

        // 3. Verificar package.json
        if (!fs.existsSync(path.join(extractPath, 'package.json'))) {
            return res.status(400).json({ error: 'Arquivo package.json não encontrado!' });
        }

        // 4. Criar Container (Isolamento)
        const container = await docker.createContainer({
            Image: 'node:18-alpine',
            name: botName,
            Tty: false,
            // Instala dependências e inicia o bot
            Cmd: ['sh', '-c', 'npm install && npm start'],
            HostConfig: {
                Binds: [`${extractPath}:/app`],
                WorkingDir: '/app',
                Memory: 512 * 1024 * 1024, // 512MB RAM
                NanoCpus: 1000000000 // 1 CPU
            }
        });

        // 5. Iniciar e Ligar Logs
        await container.start();
        attachLogStream(container, botName);

        res.json({ success: true, botId: botName });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// --- SOCKET: Conexão do Cliente ---
io.on('connection', (socket) => {
    // O site pede para "entrar na sala" de um bot específico para ver os logs
    socket.on('watch-bot', (botId) => {
        socket.join(botId);
    });
});

// Iniciar Servidor
server.listen(3000, () => {
    console.log('🚀 Servidor de Hospedagem rodando na porta 3000');
});
