
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const pub = path.join(__dirname, 'public');
app.use(express.static(pub));

app.get('/api/health', (req, res)=> res.json({ ok: true, service: 'teeradar-fullstack', ts: Date.now() }));

app.post('/api/search', (req, res)=>{
  const today = new Date().toISOString().slice(0,10);
  res.json({ slots: [
    { name:'Araluen Estate', provider:'MiClub', date: today, time:'07:00', holes: 18, spots: 4, price: 65 },
    { name:'Wembley Golf Course (Old & Tuart)', provider:'MiClub', date: today, time:'09:15', holes: 9,  spots: 2, price: 52 }
  ], ts: Date.now() });
});

app.get('/', (req,res)=> res.sendFile(path.join(pub, 'index.html')));

const port = process.env.PORT || 4242;
app.listen(port, ()=> console.log('TeeRadar fullstack running on http://localhost:'+port));
