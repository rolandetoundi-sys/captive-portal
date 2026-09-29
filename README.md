# Portail captif — Nom / Email / Téléphone

Portail captif Wi-Fi minimaliste (HTML/CSS/JS vanilla + Node.js + SQLite) qui :

- à la **première connexion**, demande le **téléphone**, puis **nom + email (obligatoire)**, envoie un **code de vérification par email (OTP)** et autorise l'accès une fois le code validé ;
- pour un visiteur **déjà enregistré**, ne redemande que le **numéro de téléphone ou l'email** (onglet « Déjà enregistré ») et autorise l'accès directement ;
- s'intègre au contrôleur **UniFi Network** auto-hébergé du client pour autoriser réellement l'accès (portail "External Portal").

## Pourquoi pas Vercel

Le contrôleur UniFi du client est **auto-hébergé sur son réseau local** (IP privée). L'application doit pouvoir l'appeler directement pour autoriser chaque appareil — ce qui est impossible depuis une fonction serverless dans le cloud. Cette app est donc pensée pour tourner **sur une machine du réseau du client** (mini-PC, NAS, Raspberry Pi...), dans Docker.

## 1. Déployer l'app

```bash
cp .env.example .env
# éditez .env avec les vraies valeurs (voir section 2 ci-dessous)

docker compose up -d --build
```

L'app écoute sur le port `3000`. Vérifiez qu'elle tourne :

```bash
curl http://localhost:3000/api/health
# -> {"ok":true}
```

## 2. Configurer l'accès au contrôleur UniFi

Le contrôleur étant auto-hébergé (pas un boîtier UDM/Cloud Gateway), il **ne supporte pas** les clés API modernes — seule l'authentification classique (compte local + mot de passe) fonctionne.

1. Dans l'interface du contrôleur UniFi, créez un **compte administrateur local dédié** (évitez un compte cloud Ubiquiti : le 2FA cloud casse ce type d'intégration).
2. Renseignez `UNIFI_CONTROLLER_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD`, `UNIFI_SITE` dans `.env`.
3. Testez la connexion :

```bash
curl http://localhost:3000/api/health/unifi
```

Si ça échoue, vérifiez en particulier :
- que la machine qui héberge Docker peut bien joindre le contrôleur (`ping`, `curl -k https://IP_CONTROLEUR:8443` depuis la même machine) ;
- le port (8443 par défaut pour une install auto-hébergée classique) ;
- que `UNIFI_SITE` correspond bien au nom du site (visible dans l'URL de l'interface UniFi, ex: `.../manage/site/default/...` → `default`).

## 3. Configurer le portail externe dans UniFi

Dans l'interface du contrôleur :

1. **Réseaux invités > Hotspot Portal** (ou *Settings > Hotspot* selon la version).
2. Activez **External Portal Server** et indiquez l'URL de cette app, par exemple :
   `http://IP_DU_SERVEUR:3000/`
3. Dans les **Pre-Authorization Allowances** (walled garden), ajoutez l'IP ou le nom d'hôte de cette app — sinon les visiteurs non authentifiés ne pourront pas charger la page du portail elle-même.
4. Assignez ce portail au SSID invité concerné.

UniFi redirigera alors chaque nouvel appareil vers `http://IP_DU_SERVEUR:3000/?ap=...&id=...&ssid=...&url=...`. L'app lit automatiquement ces paramètres (adresse MAC du client, SSID, page d'origine) pour autoriser le bon appareil et rediriger vers la bonne destination après connexion.

## 4. Fonctionnement du flux

La page propose deux onglets :

**Première connexion** (nouveau visiteur) :
1. Le visiteur saisit son **téléphone**. S'il est déjà enregistré, on l'invite à utiliser l'onglet « Déjà enregistré ».
2. Il saisit son **nom** et son **email** (les deux obligatoires).
3. Le serveur génère un code à 6 chiffres, l'envoie par email (`SMTP_*`) et le garde en mémoire (10 min, 5 tentatives max).
4. Le visiteur saisit le code reçu → le serveur le valide, crée la fiche en base, puis appelle le contrôleur UniFi (`authorize-guest`) pour débloquer l'adresse MAC de l'appareil.

**Déjà enregistré** (visiteur connu) :
1. Le visiteur saisit son **numéro de téléphone ou son email**.
2. Le serveur retrouve sa fiche et autorise directement l'accès.

Dans les deux cas, le visiteur est ensuite redirigé vers la page qu'il essayait de visiter à l'origine.

Note : les smartphones récents randomisent leur adresse MAC par réseau, donc on ne s'appuie jamais sur le MAC pour *reconnaître* un visiteur — seulement pour l'autoriser une fois identifié.

## 5. Données stockées

Table SQLite unique `guests` (fichier `data/guests.db`, persisté via le volume Docker) :

| Colonne | Description |
|---|---|
| `name`, `email`, `phone` | saisis à la première visite |
| `visit_count` | nombre de connexions |
| `first_seen_at` / `last_seen_at` | horodatage première/dernière visite |
| `last_mac` | dernière adresse MAC vue (indicatif seulement) |

## 6. Si le client migre un jour vers un boîtier UniFi OS

(UDM Pro, Cloud Gateway...) : ces appareils supportent l'API officielle moderne par clé API (`X-API-KEY`). Il faudra alors remplacer `unifi.js` par un client utilisant l'API v1 documentée par Ubiquiti :
`https://help.ui.com/hc/en-us/articles/31228198640023`

## Structure du projet

```
.
├── server.js        # routes API (lookup, register/start-verify-resend, checkin)
├── unifi.js          # intégration contrôleur UniFi (login + authorize-guest)
├── mailer.js          # envoi de l'email contenant le code OTP
├── db.js              # accès base de données (LibSQL/Turso)
├── public/            # front vanilla HTML/CSS/JS
├── Dockerfile
├── docker-compose.yml
└── .env.example
```
