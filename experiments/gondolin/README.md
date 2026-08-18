# Gondolin fail-closed spike

Laboratoire isolé, jamais chargé par le package Pi principal.

## Garanties visées

- aucune extension challenger ajoutée à la configuration globale Pi ;
- aucun montage de filesystem hôte (`vfs: null`) ;
- fixture synthétique copiée vers le guest via `vm.fs` ;
- HTTP/HTTPS refusés par allowlist vide et hooks toujours refusants ;
- mapping TCP vide, SSH absent, WebSocket désactivé ;
- DNS synthétique sans résolveur externe ;
- aucun fallback vers une commande hôte ;
- timeout fatal : abort puis fermeture de la VM entière ;
- sortie agrégée sans chemin, commande ou contenu sensible ;
- prompt borné à 100 000 caractères, 64 appels d’outils modèle et 10 minutes par session.

## Installation explicitement autorisée

```bash
brew install qemu
npm install --ignore-scripts --omit=optional --no-audit --no-fund
```

Versions du spike : QEMU 11.0.2 et `@earendil-works/gondolin` 0.12.0.

Migration du profil v2 vers le contrôleur transactionnel :

```bash
npm run transactional:install
pi update
npm run transactional:automation:enable
```

## Exécution

```bash
# Frontières filesystem/réseau/timeout
npm run spike

# Comparaison handoff/compaction avec code généré exécuté dans deux VM neuves
npm run spike:handoff

# Garde protocolaire et budgets fail-closed
npm run test:rpc-gate
npm run test:budgets

# Launcher RPC serveur : refus host + import confirmé, sans provider
npm run spike:rpc-launcher

# Vérification du profil RPC transactionnel installé
npm run deployment:status
npm run deployment:e2e

# Mise à jour Pi qualifiée, puis rollback de release
pi update
npm run deployment:rollback

# Poll automatique au chargement puis toutes les heures
npm run transactional:automation:enable
npm run transactional:automation:disable

# Vérifie le contrat source de la proposition amont sans l’appliquer
npm run check:upstream-proposal

# Les anciens runners RPC directs ci-dessous sont des preuves pré-déploiement.
# Ils nécessitent un rollback explicite car pi --mode rpc direct est désormais refusé.
# npm run spike:extension
# npm run spike:agent:policy
# npm run spike:agent:structured:policy
# npm run spike:agent:snapshot

# Tâche sur la liste projet explicitement autorisée, sans application hôte
npm run eval:representative

# Même tâche via l’entrée pi-gondolin-rpc installée
node representative-project-eval.mjs --deployed

# Paire compaction native / handoff sur la même liste et la même régression
npm run eval:representative:handoff
```

Le premier démarrage peut télécharger l’image Alpine Gondolin dans le cache local. Le run doit échouer si QEMU manque, si la VM ne démarre pas, si le probe TCP n’est pas disponible ou si une frontière attendue ne tient pas.

L’image locale occupe environ 326 MiB dans le cache Gondolin.

Le spike handoff n’expose aucun outil de mutation au modèle. Il valide strictement le chemin et la taille du patch, copie le contenu dans le guest, puis observe nominal et erreur depuis l’hôte. Le code généré ne s’exécute jamais avec le Node ou le shell hôte.

L’extension de laboratoire doit être la première extension enregistrant `bash` — Pi conserve le premier outil homonyme — avec une liste d’outils explicite. La commande `bash` native du protocole RPC contourne le hook `user_bash`. Le client des runners les refuse avant stdin et `safe-rpc-launcher.mjs` applique la même garde côté serveur avec une composition Pi fixe. Les probes passent uniquement par les outils modèle sandboxés ou des commandes d’extension fermées. L’attestation policy est retirée au timeout, à l’abort et au shutdown. L’import snapshot exige une liste explicite et une confirmation. L’export reste une prévisualisation ; seule la commande d’application séparée peut écrire sur la fixture hôte après une seconde confirmation et contrôle des hashes.

L’exception `tweetnacl@0.14.5`/Unlicense est approuvée uniquement pour Gondolin 0.12.0 aux empreintes de `license-exception.json`. Le profil RPC installé vérifie les manifestes du contrôleur, du runtime copié et de la release active avant chaque lancement. Il refuse `pi --mode rpc` direct ainsi que `rpc-entry`. `pi update` passe par une candidate isolée et ne modifie `current` qu’après intégrité npm, audit de licences, budgets et E2E Gondolin verts. `previous` permet un rollback atomique ; une incompatibilité reste fail-closed et ne déclenche pas de requalification QEMU répétée tant que la release ou le contrôleur ne change pas.
