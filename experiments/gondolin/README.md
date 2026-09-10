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
npm run transactional:status
npm run benchmark:release-integrity
pi update
npm run transactional:automation:enable
```

## Binding Node qualifié et récupération Homebrew

Le déploiement v3 exécute Pi via `node-current/node`. Ce lien sélectionne une génération
de binding privée et immuable vers un keg Node exact. Une mise à niveau Homebrew peut
supprimer cet ancien keg ; au lancement suivant, le wrapper vérifie d'abord les
manifestes puis utilise uniquement l'ancre fixe Homebrew pour qualifier le runtime
courant et remplacer `node-current` atomiquement.

Commandes opérateur :

```sh
npm run transactional:install
npm run transactional:status
PI_GONDOLIN_DEPLOYMENT_ROOT="$HOME/.local/share/pi-harness-challenger/gondolin-rpc/v3" \
  /opt/homebrew/opt/node/bin/node experiments/gondolin/update-local.mjs runtime-repin
```

`transactional:install` adopte aussi un v3 historique qui stocke directement un chemin
`Cellar`, même si ce chemin a déjà disparu. Il rafraîchit également un contrôleur lié de
révision 1 vers la révision 2, ainsi qu'une source déployée qui diffère du checkout au
sein de la révision 2. Ces opérations sont journalisées et reprennent après une
interruption sans remplacer les releases, leurs liens `current`/`previous` ni un binding
déjà qualifié.

La récupération automatique et `runtime-repin` sont volontairement étroits :

- ils agissent seulement si le binding actif exact n'est plus exécutable ;
- un binding encore sain produit `node-runtime-still-healthy` ;
- une dérive de manifeste ou d'état produit `deployment-pre-repin-invalid` ;
- une ancre différente produit `node-runtime-recovery-mismatch` ;
- un gate incompatible produit `node-runtime-qualification-refused` ;
- un Node hors Homebrew Apple Silicon ou Intel est refusé ;
- aucune recherche de runtime via `PATH`, aucun chemin passé en argument et aucun
  fallback réseau ne sont permis ;
- aucune release Pi n'est téléchargée, qualifiée ou promue par `runtime-repin`.

Les wrappers ramènent tout échec de récupération à leur refus d'intégrité stable et
n'écrivent ni stdout ni stderr du contrôleur dans un log. La qualification reçoit un
environnement allowlisté sans clés fournisseur, prompt, commande ou chemin de projet.
Homebrew constitue ici l'autorité de provenance de l'interpréteur ; les gates prouvent
la compatibilité du runtime avec la release courante, pas l'innocuité d'un binaire
Homebrew malveillant.

Exemple synthétique des champs runtime de `deployment.json` :

```json
{
  "version": 3,
  "controllerRevision": 2,
  "runtimeBindingVersion": 1,
  "nodePath": "node-current/node",
  "nodeRecoveryPath": "/opt/homebrew/opt/node/bin/node",
  "npmCommand": [
    "node-current/node",
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"
  ]
}
```

Exemple synthétique de `node-bindings/<id>/binding.json` :

```json
{
  "runtimeBindingVersion": 1,
  "bindingId": "node-26.8.1-0123456789ab",
  "canonicalNodePath": "/opt/homebrew/Cellar/node/26.8.1/bin/node",
  "nodeVersion": "v26.8.1",
  "qualifiedAt": "2026-09-09T12:00:00.000Z",
  "recoverySource": "homebrew-recovery"
}
```

Ces métadonnées conservent la preuve de qualification précédente sans PII. Le chemin
canonique est un chemin système Homebrew synthétique, jamais un répertoire utilisateur.

## Intégrité complète, transactions et audit

Après installation, les répertoires npm `.bin` sont retirés : le contrôleur appelle des
fichiers explicites et n'a pas besoin de ces symlinks. `critical.sha256` couvre ensuite
tous les fichiers réguliers de la release, sauf lui-même. Un chemin ambigu, un retour
chariot, un symlink ou un fichier spécial produit un refus stable. Les anciens manifestes
partiels ne sont remplacés qu'après vérification de leur contenu historique et passage
des gates complets ; le renommage atomique et le `fsync` du répertoire laissent toujours
un ancien ou un nouveau manifeste valide après crash.

Les promotions et rollbacks utilisent un journal de release privé. Les frontières
durables sont `prepared`, `links-active`, `qualified` et `state-active`. L'adoption ou le
refresh du contrôleur utilise `prepared`, `artifacts-installed`, `binding-active` et
`launchd-loaded`. Au redémarrage, le contrôleur restaure l'état antérieur ou termine
l'état qualifié ; il ne devine jamais un état intermédiaire.

Les opérations `release-update`, `release-rollback`, `runtime-repin`, `runtime-adoption`,
`automation-enable` et `automation-disable` écrivent sous
`audit/operations/<uuid>/`. `started.json` est durable avant la mutation et
`result.json` fixe l'issue. L'absence de résultat signale un crash. Seules les 256 plus
récentes opérations terminées sont conservées ; les opérations incomplètes ne sont
jamais élaguées. Supprimer le déploiement local est la procédure de suppression de ces
preuves. Aucun prompt, secret, chemin Home ou chemin projet n'est admis dans ce schéma.

Le repin lancé automatiquement par un wrapper porte le déclencheur d'audit `recovery` ;
un repin opérateur reste `manual`. Le job launchd porte `automatic`. Ces valeurs décrivent
la provenance et ne constituent pas une autorisation.

Refus opérateur principaux :

- `deployment-runtime-path-invalid` : le chemin persistant n'est pas exactement
  `node-current/node` ou sort de la racine ;
- `release-tree-entry-unsafe` : symlink, fichier spécial ou propriétaire inattendu ;
- `release-manifest-upgrade-current-invalid` : l'ancien manifeste ne prouve plus son
  périmètre historique ;
- `release-manifest-upgrade-qualification-refused` : la transition de confiance vers le
  manifeste complet n'a pas passé les gates ;
- `release-transaction-audit-incomplete` : une mutation précédente doit d'abord faire
  converger journal et preuve d'audit ;
- `child-environment-*` : une commande administrative a reçu un environnement non
  explicitement allowlisté.

`npm run benchmark:release-integrity` exécute 20 vérifications de la release active et
rapporte seulement `fileCount`, `runs`, `medianMs`, `p95Ms` et `maxMs`. Il n'existe pas de
seuil CI dépendant de la machine. Mesure locale du 2026-09-10 sur la release 0.84.2 :
13 186 fichiers, 20 runs, médiane 998,867 ms, p95 1 039,058 ms et maximum 1 062,543 ms.
Ce coût d'environ une seconde est payé à chaque lancement afin de conserver la
vérification complète prioritaire sur la performance. Les empreintes détectent la dérive
et la corruption ; elles ne protègent pas contre un attaquant exécuté avec le même compte
local, capable de réécrire à la fois l'arbre et son manifeste.

## Dépendances et souveraineté

Le lockfile fixe `undici` 6.28.1 (MIT) et `npm audit --omit=dev` doit rester sans finding.
Le profil réseau par défaut est explicitement `upstream-exception` / `not-sovereign` :
`pi.dev`, le registre npm et GitHub Actions n'apportent pas les preuves de résidence,
d'opérateur et d'entité juridique UE requises. Une variante compatible peut conserver
les mêmes protocoles JSON statique et npm via un descriptor Clever Cloud Cellar et un
miroir GitLab Package Registry ou Harbor opérés dans l'UE. Voir
[`docs/sovereignty.md`](../../docs/sovereignty.md).

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
