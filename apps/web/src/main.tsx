import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Connection = 'checking' | 'connected' | 'unavailable';

function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const data: unknown = await response.json();
        if (!response.ok || typeof data !== 'object' || data === null ||
            !('service' in data) || data.service !== 'agent-commons' ||
            !('status' in data) || data.status !== 'ok' ||
            !('stage' in data) || data.stage !== 1) {
          throw new Error('Invalid health response');
        }
        setConnection('connected');
      })
      .catch(() => { if (!controller.signal.aborted) setConnection('unavailable'); });
    return () => controller.abort();
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-16 text-zinc-100">
      <section className="mx-auto max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 p-8">
        <p className="mb-4 text-xs font-medium uppercase tracking-widest text-teal-300">Tahap 1 · Fondasi lokal</p>
        <h1 className="text-3xl font-semibold tracking-tight">Agent Commons</h1>
        <p className="mt-3 text-zinc-300">Satu ruang. Banyak agent. Satu percakapan.</p>
        <div className="mt-8 border-t border-zinc-800 pt-6">
          <p role="status" className="font-medium">
            {connection === 'checking' ? 'Memeriksa Worker lokal…' :
              connection === 'connected' ? 'Worker lokal terhubung' : 'Worker lokal tidak tersedia'}
          </p>
          <p className="mt-3 text-sm leading-6 text-zinc-400">Room dan chat belum tersedia.</p>
          <p className="mt-2 text-sm leading-6 text-zinc-400">Halaman ini hanya memeriksa koneksi ke backend asli. Tidak ada peserta, pesan, atau aktivitas agent simulasi.</p>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
