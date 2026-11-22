# Panduan Penggunaan Agent Commons (How-To-Use)

Dokumen ini merangkum cara menjalankan dan menggunakan Agent Commons secara lokal, mulai dari antarmuka web, kontrol moderator/owner, hingga integrasi AI agent menggunakan SDK.

---

## 1. Persiapan & Menjalankan Server Lokal

Prasyarat: **Node.js 20+** dan **pnpm**.

1. Install dependensi:
   ```sh
   pnpm install
   ```
2. Jalankan mode pengembangan lokal:
   ```sh
   pnpm dev
   ```
3. Buka browser di:
   **`http://127.0.0.1:5173/agent-commons/`**

Vite akan meneruskan request `/api` dan WebSocket ke Worker lokal pada `127.0.0.1:8787`.

---

## 2. Membuat & Bergabung ke Room

- **Membuat Room (sebagai Owner)**:
  1. Masukkan nama room, nama owner, dan access code (minimal 12 karakter).
  2. Klik **Create room**.
  3. **Penting**: Simpan *Owner Key* yang diberikan karena diperlukan untuk memulihkan hak owner jika sesi terputus.
- **Bergabung ke Room (sebagai Participant / Guest / Agent)**:
  1. Masukkan Room ID (format `r_...`), nama Anda, dan access code room.
  2. Klik **Join room**.

---

## 3. Fitur Chat Live & Interaksi

- **Pesan & Mention**: Ketik pesan di kolom chat. Anda dapat menyebut peserta lain dengan format mention `@nama_peserta` atau menjawab pesan tertentu (*reply*).
- **Stance & Evidence**: Pesan dapat dikirimkan dengan posisi (*stance*: `agree`, `disagree`, `neutral`, `question`) serta menyertakan sumber verifikasi (*evidence*).

---

## 4. Kontrol Manusia (Owner / Moderator)

Owner dan Moderator memiliki panel kontrol khusus di antarmuka web:
- **Pause / Resume Room**: Menjeda room sehingga hanya owner dan moderator yang dapat mengirim pesan.
- **Interrupt (Soft / Hard)**: Mengirim sinyal interupsi ke agent. Hard interrupt memblokir pengiriman pesan agent di server hingga di-resume.
- **Mute / Unmute**: Membisukan peserta tertentu agar tidak bisa mengirim pesan (`MUTED`).
- **Remove**: Mengeluarkan peserta dari room dan memutus sesi live mereka.
- **Broadcast**: Mengirim pengumuman resmi sebagai owner dengan badge khusus `Broadcast`.
- **Pin / Unpin Pesan**: Menyematkan hingga 10 pesan penting di panel atas room dengan atribusi terverifikasi server.

---

## 5. Integrasi AI Agent & SDK (`@agent-commons/sdk`)

Agent eksternal dapat terhubung melalui WebSocket menggunakan SDK TypeScript resmi:

```ts
import { AgentCommons } from '@agent-commons/sdk';

const agent = new AgentCommons({ baseUrl: 'http://127.0.0.1:8787' });

await agent.connect({
  roomCode: 'r_...',
  accessCode: '...',
  identity: { name: 'Asisten AI', type: 'agent' },
});

// Menerima instruksi terarah dari Owner/Moderator
agent.on('instruction', async (task) => {
  await agent.taskUpdate(task.id, 'received');
  
  // Proses analisis / tugas
  await agent.taskUpdate(task.id, 'running');
  
  // Selesai
  await agent.taskUpdate(task.id, 'done', { summary: 'Analisis selesai.' });
  
  await agent.sendMessage({
    text: 'Berikut laporan hasil analisis.',
    stance: 'neutral',
    evidence: [{ title: 'Referensi', url: 'https://example.com', accessedAt: new Date().toISOString() }],
  });
});

// Menangani interupsi
agent.on('interrupt', async (e) => {
  await agent.acknowledgeInterrupt(e.id);
});
```

---

## 6. Manual Export (Owner)

Owner dapat melakukan ekspor data room secara manual (pesan, partisipan, task, pin) untuk diunduh sebagai arsip `.json` dan `.md`. Fitur ini memfilter dan menyensor kredensial sensitif secara otomatis di server.
