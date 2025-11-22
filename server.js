const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' }); // No Windows pode precisar ajustar isso
const upload = multer({ dest: 'temp/' }); // Onde o zip chega primeiro

app.use(express.static('public')); // Serve o frontend
app.use(express.json());

// ROTA PRINCIPAL: Upload e Deploy
app.post('/upload', upload.single('botFile'), async (req, res) => {
    const botName = req.body.botName.replace(/\s+/g, '-').toLowerCase(); // Sanitiza o nome
    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, 'bots', botName);

    try {
        // 1. Limpeza: Se o bot já existe, removemos a pasta antiga e o container antigo
        if (fs.existsSync(extractPath)) {
            await fs.remove(extractPath);
            try {
                const oldContainer = docker.getContainer(botName);
                await oldContainer.stop();
                await oldContainer.remove();
            } catch (e) { /* Ignora erro se container não existir */ }
        }

        // 2. Descompactar o arquivo
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);
        fs.unlinkSync(zipPath); // Deleta o zip temporário

        // 3. Verificar se é um bot Node.js (tem package.json?)
        if (!fs.existsSync(path.join(extractPath, 'package.json'))) {
            return res.status(400).json({ error: 'Erro: package.json não encontrado no ZIP!' });
        }

        // 4. CRIAR O CONTAINER DOCKER
        // O segredo: Usamos "sh -c" para instalar dependências antes de iniciar
        const container = await docker.createContainer({
            Image: 'node:18-alpine', 
            name: botName,
            Tty: true,
            Cmd: ['sh', '-c', 'npm install && npm start'], 
            HostConfig: {
                Binds: [`${extractPath}:/app`], // Liga a pasta do PC ao Container
                WorkingDir: '/app',
                Memory: 512 * 1024 * 1024, // Limite de 512MB RAM
                NanoCpus: 1000000000 // Limite de 1 CPU
            },
            NetworkMode: 'bridge'
        });

        // 5. Iniciar
        await container.start();

        res.json({ success: true, message: `Bot ${botName} implantado e rodando!` });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Rota para ver logs do bot
app.get('/logs/:botName', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.botName);
        const logs = await container.logs({ stdout: true, stderr: true, tail: 50 });
        res.send(logs.toString('utf8'));
    } catch (error) {
        res.status(404).send("Bot offline ou não encontrado.");
    }
});

app.listen(3000, () => {
    console.log('🚀 Discloud Clone rodando em http://localhost:3000');
});
