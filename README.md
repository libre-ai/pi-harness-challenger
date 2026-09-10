# Pi Harness Challenger

Package local d’expérimentation pour renforcer le harness Pi **sans remplacer ses ressources existantes**.

## Statut

Phase A corrigée dans le package : `policy-gate` durable, `/handoff` vérifié en RPC avec valeur de focalisation mesurée, et `verify-runtime` manuel. Le statut agrégé interdit actuellement toute promotion globale. `trust-boundary` et `review-challenge` ont été retirés après des confrontations sans gain différentiel. Le package n’est pas installé dans la configuration globale.

Documents de décision :

- [revue de confrontation de la phase A](./docs/phase-a-challenge-review.md) ;
- [plan conditionnel de la phase B](./docs/phase-b-plan.md).

Le package :

- n’altère pas `~/.pi/agent/AGENTS.md` ;
- ne remplace aucun outil intégré ;
- ne charge aucun prompt global ;
- ne persiste ni commande, ni chemin, ni contenu d’outil ; seule la configuration minimale des modes est durable ;
- n’ajoute aucune dépendance d’exécution tierce.

## Extension `policy-gate`

L’extension intercepte les événements `tool_call`, puis classe l’opération :

- `R0` : lecture simple ;
- `R1` : mutation locale structurée et normalement réversible ;
- `R2` : cible sensible, commande shell non classifiée ou outil sans capacité déclarée ;
- `R3` : effet externe ou opération destructive large.

Modes disponibles :

| Mode | Comportement |
|---|---|
| `off` | aucune classification |
| `observe` | compte les risques en mémoire, n’empêche aucune opération |
| `confirm` | demande une confirmation pour R2/R3 ; bloque R2/R3 sans UI |
| `enforce` | bloque les opérations explicitement interdites, confirme les autres R2/R3 |

Sans configuration, le mode par défaut est `observe`. Une commande de changement l’enregistre atomiquement dans `${XDG_CONFIG_HOME:-~/.config}/pi-harness-challenger/config.json` avec permissions `0600`; le mode survit donc à `/new`, `/resume`, `/fork`, `/handoff` et `/reload`.

Commande interactive :

```text
/policy-gate
/policy-gate status
/policy-gate observe
/policy-gate confirm
/policy-gate enforce
/policy-gate off
```

Une baisse de protection exige une confirmation et est refusée sans UI. Le flag `--policy-gate-mode <mode>` peut renforcer la configuration durable pour un processus, jamais l’affaiblir. Le chemin peut être isolé avec `PI_HARNESS_CHALLENGER_CONFIG`; aucun `settings.json` Pi n’est modifié.

**Sans sandbox, gate raté :** en mode `confirm`, 11 opérations sur 16 demandent une confirmation (68,75 %, seuil <10 %). Avec une attestation Gondolin active (`hostMounts=0`, `network=deny`, probe vivant), le même corpus tombe à 0 confirmation sans regex supplémentaire ; une session agentique en mode `confirm` passe aussi. Le mode non sandboxé reste bloqué et aucune promotion globale n’en découle. Voir le [rapport agrégé](./evals/reports/2026-07-20-policy-friction.json).

## Expérience rejetée : `trust-boundary`

Trois scénarios appariés ont comparé le harness actuel et l’extension : deux injections factices et une procédure README légitime. Les deux variantes ont eu exactement les mêmes résultats ; l’extension n’apporte donc aucune valeur incrémentale sur ce corpus et ce modèle. Elle a été retirée plutôt que conservée par défaut. Voir le [rapport agrégé](./evals/reports/2026-07-20-trust-boundary.json).

## Commande `/handoff`

```text
/handoff <objectif de la nouvelle session>
```

La commande construit localement un brouillon à partir du dernier résumé de compaction ou de branche, d’extraits récents bornés, de blocs d’état et des chemins projet observés. Elle exclut les sorties d’outils, le thinking, les chemins sensibles et les chemins hors workspace.

Le brouillon est ouvert dans l’éditeur. Une session enfant n’est créée qu’après validation ; le texte reste dans l’éditeur de la nouvelle session et n’est envoyé au provider qu’au moment où l’utilisateur le soumet. Aucun appel LLM supplémentaire n’est effectué par l’extension.

La redaction est défensive mais ne peut pas reconnaître toute donnée confidentielle ou personnelle. La validation humaine du brouillon reste obligatoire.

Face à la compaction native sur une session factice longue, les deux variantes conservent 7/7 marqueurs. Dans deux sessions fraîches, elles restituent encore 7/7 faits sans outil ; le handoff consomme 1 098 tokens contre 20 358 pour le contexte natif. Une première synthèse de patch a été **invalidée** parce que son runner exécutait le code généré avec le Node hôte ; ce runner reste supprimé. Après autorisation explicite, deux nouveaux runs ont exécuté le code uniquement dans des VM Gondolin neuves : nominal + erreur passent des deux côtés, avec 1 325–1 697 tokens handoff contre 20 946–21 705 natifs. Voir les rapports [qualité](./evals/reports/2026-07-20-handoff-quality.json), [invalidation](./evals/reports/2026-07-20-handoff-code.json) et [Gondolin](./evals/reports/2026-07-20-gondolin-spike.json).

## Skill challenger retenu

Le skill reste masqué de l’invocation automatique afin de ne pas concurrencer les procédures locales existantes :

```text
/skill:verify-runtime [cible]
```

`verify-runtime` sépare l’observation de surface des tests et doit déléguer à `verify-portail` lorsqu’il s’agit d’un portail déployé. Sur fixtures, il a exercé un binaire CLI installé avec probe adjacent, vérifié une API nominale + malformée sans relancer les tests et retourné `SKIP` pour de la documentation. La découverte de `~/.agents/skills` a été corrigée après le premier run. Voir le [rapport agrégé](./evals/reports/2026-07-20-verify-runtime.json).

Cette valeur justifie son maintien dans le challenger, **pas sa promotion globale** : la délégation portail et la capture reproductible durée/tokens restent à prouver. Il ne modifie pas les skills globaux `test` ou `verify-portail`.

`review-challenge` a détecté les deux défauts attendus, mais le skill global `review` les a également détectés, avec une suggestion de complétude valide supplémentaire et moins d’appels sur un diff correct. Le challenger a donc été retiré. Voir le [rapport agrégé](./evals/reports/2026-07-20-review-challenge.json).

## Limites de sécurité

Cette extension est une garde d’usage, pas un sandbox. Elle reconnaît des opérations à haut signal, mais ne peut pas interpréter de manière exhaustive toutes les constructions shell, scripts indirects, alias ou exécutables arbitraires.

Le spike Gondolin/QEMU explicitement autorisé passe deux fois les probes filesystem, réseau contrôlé et timeout, puis deux continuations de code sandboxées. Il reste exclu du package principal ; l’exception `tweetnacl`/Unlicense est désormais approuvée uniquement aux empreintes revues et le profil RPC est déployé derrière une entrée hash-pinnée. L’exemple `sandbox-runtime` reste rejeté tel quel car réseau permissif et fail-open. Voir [`docs/b1-sandbox-evaluation.md`](./docs/b1-sandbox-evaluation.md).

## Expérience Gondolin isolée

```bash
npm --prefix experiments/gondolin run spike
npm --prefix experiments/gondolin run spike:handoff
npm --prefix experiments/gondolin run spike:extension
npm --prefix experiments/gondolin run spike:agent
```

QEMU 11.0.2 et les dépendances du sous-package ont été installés sur accord explicite. `experiments/` est exclu du package npm principal et aucune ressource Pi globale ne le charge. Deux sessions agentiques ont corrigé la fixture avec 4 puis 5 appels `bash`, puis deux runs structurés ont utilisé exactement `read → edit → bash` sous policy `confirm`. Tous les résultats sont attestés Gondolin. Un workflow snapshot synthétique copie une allowlist après confirmation, ouvre les changements dans l’éditeur, puis applique avec remplacement atomique de chaque fichier après une seconde confirmation. Aucun code produit n’est exécuté sur l’hôte. Les cinq cas comportementaux restants passent ensuite sans application hôte, mais la commande `bash` RPC native contourne le hook `user_bash`. Un launcher serveur à composition fixe la refuse désormais avant Pi, même avec un client non gardé ; l’entrée installée `pi --mode rpc` refuse aussi les appels directs et réserve le RPC supporté à `pi-gondolin-rpc`. Deux runs supplémentaires réparent dans Gondolin une régression injectée dans une copie de quatre fichiers projet explicitement autorisés : suite et probe indépendant passent, sans écriture source ni apply. Sur une paire compaction/handoff du même projet, les deux réussissent ; le handoff réduit les tokens de 80,3 % et la durée de 27 %. La cause du bypass est confirmée dans Pi 0.80.10 ; un patch minimal et une API fail-closed sont proposés sans modifier l’installation ni effectuer de soumission réseau. L’exception Unlicense hash-pinnée et le déploiement ont été approuvés explicitement. Un run provider final via l’entrée installée réussit suite et probe avec 11/11 outils attestés, sans écriture hôte. `eval:status` distingue désormais le profil sans sandbox (non prêt) du profil Gondolin déployé (promotion de profil autorisée) ; le package challenger complet reste bloqué. Voir les rapports [Gondolin](./evals/reports/2026-07-20-gondolin-spike.json), [run installé](./evals/reports/2026-07-21-deployed-representative.json), [cas restants](./evals/reports/2026-07-20-remaining-cases.json) et [licence](./evals/reports/2026-07-20-unlicense-review.json).

## Vérification

```bash
npm test
npm run smoke
npm run smoke:skills
npm run smoke:rpc
npm run smoke:handoff
npm run smoke:policy
npm run check

# Manuel : appelle le provider pour comparer handoff et compaction
npm run eval:handoff

# Manuel : ajoute deux reprises factuelles en sessions fraîches
npm run eval:handoff:continuation


# Offline : mesure la friction du policy-gate
npm run eval:policy

# Offline : vérifie les signaux R2/R3 sans exécuter les commandes
npm run eval:policy:safety

# Offline : compare la friction avec attestation Gondolin active
npm run eval:policy:sandbox

# Offline : vérifie les prérequis des backends sandbox
npm run eval:sandbox

# Offline : audite les licences transitives des exemples Pi
npm run eval:sandbox:licenses

# Offline : agrège verdicts, preuves et gates de promotion
npm run eval:status

# Vérifie le déploiement transactionnel, la release active et ses empreintes
npm run deployment:status

# Mesure 20 vérifications complètes de la release active
npm run benchmark:release-integrity

# Met à jour Pi via candidate isolée + gates Gondolin
pi update

# Revient atomiquement à la release Pi qualifiée précédente
npm run deployment:rollback

# Active ou retire la vérification automatique launchd
npm run transactional:automation:enable
npm run transactional:automation:disable
```

Les smoke tests non-RPC chargent explicitement les extensions et le skill avec les autres ressources désactivées. Le smoke RPC passe exclusivement par l’entrée `pi-gondolin-rpc` installée : il refuse la commande RPC native `bash`, confirme l’import du snapshot et vérifie l’absence d’écriture hôte, sans provider.

## Essai isolé

Sans installation globale :

```bash
pi --no-extensions -e ./extensions/policy-gate/index.mjs
```

`--no-extensions` désactive l’auto-découverte ; le chemin `-e` reste explicitement chargé.

## Déploiement local

Le profil RPC Gondolin est déployé sans ajouter les extensions challenger à `settings.json`. `pi --mode rpc` direct et l’export `rpc-entry` sont refusés ; `pi-gondolin-rpc` exige une racine et une allowlist de snapshot. Le déploiement borne chaque prompt à 100 000 caractères, chaque session à 64 appels d’outils et 10 minutes.

La migration initiale s’exécute depuis un profil v2 vert :

```bash
npm run transactional:install
pi update
npm run transactional:automation:enable
```

Depuis le profil v3, `pi update` installe la version cible dans une candidate privée, vérifie l’intégrité npm et les licences, rejoue les gates CLI/RPC/Gondolin, puis bascule `current` atomiquement. `previous` reste disponible pour `npm run deployment:rollback`. Une candidate incompatible reste bloquée sans modifier la release active ; `pi update --force` permet une requalification explicite après évolution du contrôleur. Le runtime déployé est copié et manifesté : le checkout source peut être retiré sans casser Pi. La révision 2 du contrôleur stocke `node-current/node` comme chemin relatif et rafraîchit les anciens déploiements liés sans remplacer leur binding ni leurs releases.

Chaque fichier régulier d’une release est couvert par son manifeste ; les symlinks et fichiers spéciaux sont refusés. Cette protection détecte la corruption et la dérive accidentelle, mais pas un processus malveillant disposant déjà des droits du même utilisateur et capable de réécrire simultanément fichiers et manifeste.

L’agent utilisateur `launchd` optionnel exécute le même contrôle au chargement puis toutes les heures. Il ne promeut que les versions compatibles, marque explicitement le déclencheur `automatic` et neutralise stdout/stderr. Son plist privé contient nécessairement des chemins absolus et `HOME` : c’est l’exception d’intégration macOS, jamais copiée dans l’audit. Les opérations de release, binding, adoption et automation gardent jusqu’à 256 preuves locales terminées ; une preuve incomplète n’est jamais supprimée automatiquement. Voir [ADR-0001](./docs/adr-0001-transactional-pi-updates.md) et [l’analyse de souveraineté](./docs/sovereignty.md).

## Activation globale du package complet

Toujours refusée. Une éventuelle installation directe du package utiliserait :

```bash
pi install /chemin/absolu/vers/pi-harness-challenger
```

Le retrait correspondant est :

```bash
pi remove /chemin/absolu/vers/pi-harness-challenger
```

Ne pas activer le package complet : le gate de friction policy sans sandbox reste en échec et la délégation portail de `verify-runtime` n’est pas encore prouvée.
