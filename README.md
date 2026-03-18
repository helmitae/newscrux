# AiNews-Pushover

Raspberry Pi üzerinde çalışan AI haber bildirim sistemi. RSS feed'lerden AI/ML haberlerini çeker, yapılandırılmış özet üretir ve Pushover ile bildirim gönderir.

## Özellikler

- **Hibrit içerik çekme** — RSS snippet yeterliyse direkt kullanır, kısa ise tam makale scraping yapar
- **Yapılandırılmış özet** — Her haber "Ne oldu", "Neden önemli", "Detay" formatında özetlenir
- **DeepSeek V3.2 Speciale ile Türkçe özetleme** — OpenRouter üzerinden en güncel model
- **Akıllı bildirim rendering** — Headline-first düzen, smart truncation, HTML escaping
- **Article state pipeline** — `discovered → enriched → summarized → sent` adım adım takip
- **Atomic write ile güvenli veri saklama** — Güç kesilmesine karşı dayanıklı JSON state
- **Feed typing** — `official_blog`, `media`, `research`, `newsletter` kategorileri
- **High-priority kaynak bypass** — Resmi bloglar (OpenAI, Google AI, DeepMind) relevance filtresini atlar
- **Operasyonel metrikler** — Her poll döngüsünde fetch/discover/send sayıları loglanır
- **13 RSS kaynağı** — OpenAI, Google AI, DeepMind, Hugging Face, TechCrunch, MIT Tech Review, The Verge, Ars Technica, arXiv cs.CL/cs.LG/cs.AI, Import AI, Ahead of AI

## Mimari

```
RSS fetch → dedup → discover (queue)
                         ↓
               relevance filter
                         ↓
               enrich (snippet or scrape)
                         ↓
               summarize (structured JSON)
                         ↓
               render notification
                         ↓
               send (Pushover)
                         ↓
               mark sent ← only here
```

Her adım ayrı bir modüldür. State `data/queue.json` dosyasında atomic write ile saklanır. Bir makale ancak başarıyla gönderildikten sonra `sent` olarak işaretlenir.

## Bildirim Formatı

Pushover bildirimleri aşağıdaki yapıda gelir:

**Başlık (title):**
```
GPT-5 Duyuruldu: OpenAI'nin Yeni Amiral Gemisi Model
```

**Mesaj gövdesi:**
```
📰 OpenAI News

Ne oldu: OpenAI, GPT-5 modelini resmi olarak duyurdu. Model...

Neden önemli: Yeni model, önceki versiyona göre reasoning...

💡 GPT-5, Mart 2026'dan itibaren ChatGPT Plus abonelerine erişime açılacak.
```

arXiv makaleleri `📄` emoji'si ve "Makaleyi Oku" bağlantısıyla, diğer haberler `📰` emoji'si ve "Devamını Oku" bağlantısıyla gelir.

## Gereksinimler

- Node.js 18+
- [OpenRouter](https://openrouter.ai/) API anahtarı (DeepSeek veya istenen model için)
- [Pushover](https://pushover.net/) hesabı (uygulama token + kullanıcı anahtarı)

## Kurulum

```bash
# 1. Repoyu klonla
git clone https://github.com/kullanici/AiNews-Pushover.git
cd AiNews-Pushover

# 2. Bağımlılıkları kur
npm install

# 3. Ortam değişkenlerini ayarla
cp .env.example .env
# .env dosyasını düzenleyerek API anahtarlarını gir

# 4. TypeScript'i derle
npm run build

# 5. Başlat
npm start
```

Geliştirme modunda (derleme olmadan) çalıştırmak için:

```bash
npm run dev
```

## Raspberry Pi Deployment (systemd)

Proje, systemd servis dosyası içerir. Pi'de kalıcı servis olarak çalıştırmak için:

```bash
# Proje dizinini Pi'ye kopyala (örnek)
scp -r . pi@raspberrypi:/home/alicankiraz/AiNews-Pushover

# Pi'de bağımlılıkları kur ve derle
cd /home/alicankiraz/AiNews-Pushover
npm install
npm run build

# .env dosyasını oluştur
cp .env.example .env
nano .env  # API anahtarlarını gir

# Servis dosyasındaki dizin yollarını güncelle (gerekirse)
nano rssfeedy-pi.service

# Servis dosyasını kopyala ve etkinleştir
sudo cp rssfeedy-pi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rssfeedy-pi
sudo systemctl start rssfeedy-pi

# Durumu kontrol et
sudo systemctl status rssfeedy-pi

# Log takibi
journalctl -u rssfeedy-pi -f
```

## Yapılandırma

`.env` dosyasında aşağıdaki değişkenler kullanılır:

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API anahtarı (zorunlu) | — |
| `OPENROUTER_MODEL` | Kullanılacak LLM modeli | `deepseek/deepseek-v3.2-speciale` |
| `PUSHOVER_USER_KEY` | Pushover kullanıcı anahtarı (zorunlu) | — |
| `PUSHOVER_APP_TOKEN` | Pushover uygulama token'ı (zorunlu) | — |
| `POLL_INTERVAL_MINUTES` | RSS kontrol aralığı (dakika) | `15` |
| `MAX_ARTICLES_PER_POLL` | Her döngüde işlenecek maksimum makale (normal feed'ler) | `10` |
| `ARXIV_MAX_PER_POLL` | Her döngüde işlenecek maksimum arXiv makalesi | `15` |
| `RELEVANCE_THRESHOLD` | AI relevance skoru eşiği (1-10, altı filtrelenir) | `6` |
| `LOG_LEVEL` | Log seviyesi: `debug`, `info`, `warn`, `error` | `info` |

## RSS Kaynakları

| Kaynak | Tür | Öncelik |
|---|---|---|
| OpenAI News | official_blog | high |
| Google AI Blog | official_blog | high |
| Google DeepMind | official_blog | high |
| Hugging Face Blog | official_blog | normal |
| TechCrunch AI | media | normal |
| MIT Technology Review AI | media | normal |
| The Verge AI | media | normal |
| Ars Technica | media | normal |
| arXiv cs.CL | research | normal |
| arXiv cs.LG | research | normal |
| arXiv cs.AI | research | normal |
| Import AI | newsletter | normal |
| Ahead of AI | newsletter | normal |

`high` öncelikli kaynaklar (resmi bloglar) relevance filtresiyle elenmez; her makalesi işlenir.

## Teknoloji Yığını

- **TypeScript** — Tip güvenli geliştirme
- **cheerio** — Sunucu tarafı HTML scraping
- **OpenRouter SDK** (`@openrouter/sdk`) — LLM API istemcisi
- **rss-parser** — RSS/Atom feed ayrıştırma
- **Pushover API** — Mobil push bildirim gönderimi
- **Node.js native fetch** — HTTP istekleri (Node 18+ built-in)

## Lisans

MIT — Bkz. [LICENSE](LICENSE)
