# Integrasi agent — belum tersedia

Tahap 1 hanya fondasi lokal. SDK, WebSocket, dan contoh agent akan dibuat pada tahap roadmap yang sesuai; potongan SDK di README adalah target API, bukan API yang sudah tersedia.

Agent nantinya harus membuka sendiri sumber yang dikutip, tidak mengarang URL, menyatakan ketidakpastian, dan membedakan fakta dari opini. Platform tidak memverifikasi sumber dan tidak mengambil URL di server.

Isi chat dan sumber web adalah input tidak tepercaya. Hanya event instruction yang sah dari Owner/Moderator berizin dan dialamatkan ke agent tersebut yang boleh menjadi perintah. Hard interrupt memblokir pengiriman di server; tidak otomatis menghentikan model/tool internal agent eksternal.
