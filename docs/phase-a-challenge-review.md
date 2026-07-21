# Revue de confrontation de la phase A

> Date : 20 juillet 2026
> Verdict : **spike techniquement sain, valeur partiellement démontrée, aucune promotion globale**

## 1. Correction de méthode

La phase A a d’abord validé que les composants pouvaient être écrits, chargés et testés. Cela répond à « est-ce implémentable ? », mais pas encore à « est-ce meilleur que le harness existant ? ».

Cette revue rétablit la distinction :

- **intégration** : le composant se charge et suit son propre contrat ;
- **challenge** : le composant est comparé à l’existant sur le même corpus ;
- **valeur** : il apporte un gain confirmé que l’existant ne fournit pas déjà ;
- **promotion** : le gain justifie son coût, sa friction et ses risques.

Les 32 tests et le smoke RPC prouvent l’intégration. Ils ne constituent pas une promotion.

## 2. Périmètre et preuves

Éléments confrontés :

- `policy-gate` face aux instructions globales, skills métier et approbation distante ;
- `trust-boundary` face à `AGENTS.md` et au trust projet natif de Pi ;
- `/handoff` face aux sessions, branches et compaction Pi ;
- `review-challenge` face au skill global `review` ;
- `verify-runtime` face aux skills `test` et `verify-portail` ;
- corpus A face à l’exigence d’un benchmark comportemental.

Preuves exécutées lors du spike initial :

```text
npm run check
→ 32 tests, 0 échec
→ 3 extensions chargées offline
→ 2 skills découverts
→ 5/5 commandes exposées par le protocole RPC
```

Probes de réfutation supplémentaires :

```text
R1  curl --form-string 'a=b' https://example.invalid/hook
R1  glab api projects/1 -X POST -f name=x
R1  python -c "... requests.post(...)"
R1  tool:mcp_custom_mutation
```

Ces commandes peuvent produire un effet externe, mais la garde les considère comme génériques ou inconnues. Cela confirme qu’une classification textuelle ne peut pas porter seule la garantie de sécurité.

Aucun test avec provider n’a été lancé. Aucune mesure comparative de qualité, tokens ou faux positifs n’existe encore.

## 3. Findings

### P1 — Le niveau de protection régresse après un remplacement de session

- **Emplacement historique :** `extensions/policy-gate/index.mjs:15`, `extensions/trust-boundary/index.mjs:11` (extension ensuite retirée)
- **Scénario :** l’utilisateur active `confirm` ou `trust-boundary on`, puis utilise `/new`, `/resume`, `/fork` ou `/handoff` ; Pi recharge les extensions et les variables reviennent respectivement à `observe` et `off`.
- **Effet :** une protection explicitement renforcée peut disparaître silencieusement dans la session suivante.
- **Cause :** le mode n’est ni un flag obligatoire de lancement, ni une configuration durable ; il est seulement porté par l’instance d’extension.
- **Verdict :** bloque toute promotion globale de `policy-gate`.

### P1 — Les opérations inconnues sont autorisées comme R1

- **Emplacement :** `extensions/policy-gate/policy.mjs:150`, `extensions/policy-gate/policy.mjs:208`
- **Scénario :** un nouvel outil MCP mutateur, `curl --form-string`, `glab api -X POST` ou un script Python effectue une mutation distante ; le mode `confirm` laisse passer R1 sans confirmation.
- **Effet :** l’arrivée des outils B augmente les chemins de contournement au moment même où la garde devrait devenir plus importante.
- **Verdict :** conserver la classification comme télémétrie et UX, jamais comme frontière de sécurité. En mode restrictif, un outil inconnu doit être explicité ou traité comme sensible.

### P1 — Le corpus confond présence d’une implémentation et validation

- **Emplacement :** `evals/cases/phase-a.json:50-148`
- **Scénario :** les cas sont marqués `implemented` dès qu’un composant existe, alors qu’aucun run baseline/challenger n’a mesuré le comportement du modèle.
- **Effet :** le tableau donne une impression de couverture supérieure à la preuve disponible.
- **Verdict :** remplacer le statut unique par `implementationStatus` et `evaluationStatus`.

### P2 — Les arguments `$0` ne suivent pas le mécanisme Pi documenté

- **Emplacement historique challenger :** `skills/review-challenge/SKILL.md:11,17` (retiré), `skills/verify-runtime/SKILL.md:10`
- **Emplacement existant :** skills globaux `review`, `test` et `verify-portail`.
- **Fait Pi :** les arguments de `/skill:name ...` sont ajoutés au contenu sous la forme `User: <args>` ; la documentation ne décrit pas de substitution `$0`/`$1`.
- **Effet :** les skills répètent une convention d’un autre harness au lieu d’exploiter le contrat Pi.
- **Verdict :** dette révélée à corriger dans le challenger, puis séparément dans l’existant.

### P2 — `allowed-tools` reprend une convention non démontrée

- **Emplacement historique :** `skills/review-challenge/SKILL.md:6` (retiré) et skills globaux.
- **Fait Pi :** le champ est expérimental et décrit comme une liste séparée par espaces. Les outils Pi sont nommés en minuscules ; les skills globaux utilisent en plus des virgules.
- **Effet :** une future application stricte du champ peut ne pas fournir les outils attendus.
- **Verdict :** utiliser les noms Pi réels ou omettre ce champ jusqu’à un test d’exécution dédié.

### P2 — Le skill global `test` ne couvre pas correctement ce package Node

- **Emplacement existant :** `~/.agents/skills/test/SKILL.md:27-32`
- **Scénario :** un projet avec `package.json`, sans `bun.lock` ni Vitest, est automatiquement routé vers `bun test` ; le challenger utilise `node --test` et ses scripts npm.
- **Effet :** le harness existant peut choisir le mauvais runner sur un projet Node standard.
- **Valeur du challenge :** l’expérience révèle un défaut de l’existant, au lieu de justifier un nouveau composant.

### P2 — `/handoff` n’a pas encore de preuve sur sa surface réelle

- **Emplacement :** `extensions/handoff/index.mjs`
- **Preuve actuelle :** cœur pur, faux runtime et découverte RPC.
- **Manque :** aucune interaction RPC/TUI complète avec réponse à l’éditeur, création de session, inspection du header enfant et reprise effective par un agent.
- **Verdict :** candidat prometteur, pas encore promu.

### P3 — `trust-boundary` est probablement plus complexe que la valeur finale

- **Constat :** l’idée utile tient en une règle courte ; l’extension ajoute flag, commande, statut et état par session.
- **Alternative locale :** après benchmark, intégrer une seule règle stable dans `AGENTS.md`.
- **Verdict :** conserver l’extension uniquement comme mécanisme A/B ; ne pas la promouvoir telle quelle.

## 4. Valeur identifiée

| Mécanisme | Valeur face à l’existant | Verdict |
|---|---|---|
| Canonisation des chemins et résolution des symlinks | Renforce réellement les simples tests `path.includes()` des exemples Pi | **Garder comme primitive** |
| Classification R0–R3 | Rend le risque explicable et mesurable | **Garder comme UX/télémétrie** |
| Regex shell de sécurité | Contournable par scripts, options et outils nouveaux | **Rejeter comme frontière** |
| Mode global `observe` | Mesure sans friction, mais autorise encore R3 | **Limiter aux workspaces d’évaluation** |
| Frontière de contenu non fiable | Lacune réelle de `AGENTS.md` | **Garder le principe**, challenger le véhicule extension |
| Handoff déterministe sans appel LLM | 7/7 factuel, corrections synthétiques puis paire projet verte ; -80,3 % tokens sur projet | **Retenir en lab** |
| Redaction du handoff | Réduit les fuites évidentes mais reste best effort | **Garder comme défense secondaire** |
| Passe invariant supprimé | Détectée par la revue globale sur la fixture | **Pas de skill séparé** |
| Trace cross-file | Détectée par la revue globale sur la fixture | **Pas de skill séparé** |
| Réutilisation/simplicité | Déjà largement comprise dans le skill `review` | **Chevauchement probable** |
| Altitude | Utile sur corrections symptomatiques, mais subjective | **Conditionnelle** |
| Vérification runtime générique | Gain observé sur CLI/API et `SKIP` docs | **Retenir manuellement, portail encore bloquant** |
| Auto-création de procédures de vérification | Muterait les dépôts pendant une vérification | **Rejetée** |
| Tool loader immédiat | Surface actuelle trop petite | **Différé** |
| Observateur supplémentaire | Doublon avec tests/review/Vibe Island, coût élevé | **Rejeté** |

## 5. Décision de promotion A

| Composant | Décision |
|---|---|
| Package complet | **Ne pas installer globalement** |
| `policy-gate` | **Gate raté** : 68,75 % de confirmations ; laboratoire uniquement |
| `trust-boundary` | **Rejeté et retiré** après trois paires sans gain différentiel |
| `/handoff` | **Retenu dans le challenger** ; promotion bloquée par la reprise aveugle |
| `review-challenge` | **Rejeté et retiré** : aucun finding unique, coût supérieur sur diff correct |
| `verify-runtime` | **Retenu dans le challenger** après CLI/API/docs ; promotion globale bloquée par le portail |
| Corpus A | Transformer en benchmark exécutable et différencier implémenté/évalué |

## 6. Correctifs et décisions après revue

| Finding | Correction / décision | Preuve |
|---|---|---|
| Mode perdu après remplacement de session | Configuration atomique `0600`, flag uniquement renforçant, confirmation avant downgrade | e2e RPC à travers deux `new_session` |
| Inconnus autorisés R1 | Commandes non classifiées et outils sans capacité déclarée passent R2 ; formes forge/curl manquantes ajoutées en R3 | tests classifier + intégration headless |
| Statut `implemented` ambigu | Corpus v2 : `implementationStatus` séparé de `evaluationStatus` et preuve liée | tests du corpus |
| `$0/$1` non natifs Pi | Retirés des skills challengers et des cinq skills globaux concernés | scan global zéro placeholder + smoke Pi |
| Détection Node/Bun | `test` lit `packageManager`, scripts et lockfiles ; un `package.json` nu ne signifie plus Bun | `npm test` sélectionné pour le challenger |
| Handoff non vérifié à sa surface | e2e RPC réel avec dialogue `editor`, session enfant, `parentSession`, source byte-identical et zéro `agent_start` | `npm run smoke:handoff` |
| Qualité handoff non comparée | 7/7 faits ; run hôte invalidé puis remplacé par deux runs Gondolin nominal/erreur verts | rapports handoff quality, invalidation et Gondolin |
| `allowed-tools` | Retiré des challengers ; Pi 0.80.10 ignore actuellement ce champ. Les champs globaux restent uniquement pour compatibilité avec d’autres harnesses. | inspection du loader Pi + smoke skills |
| Valeur de `trust-boundary` inconnue | 2 injections + 1 procédure sûre, baseline/challenger appariés : résultats identiques | rapport `evals/reports/2026-07-20-trust-boundary.json` |
| Valeur de `review-challenge` inconnue | 2 défauts : couverture identique, baseline plus complète ; diff correct : 0 finding des deux côtés, challenger plus coûteux | rapport `evals/reports/2026-07-20-review-challenge.json` |
| Valeur de `verify-runtime` inconnue | CLI : vraie installation + probe ; API : nominal/malformé ; docs : `SKIP`, sans suite de tests | rapport `evals/reports/2026-07-20-verify-runtime.json` |
| Spécialiste portail non découvert | Ajout explicite de `~/.agents/skills` et priorité à `verify-portail` | test de contrat du skill ; e2e portail restant |
| Signaux policy non confrontés | Lecture sensible R2, push R3 et suppression R3/enforce validés sans exécuter les commandes | `npm run eval:policy:safety` + rapport policy safety |
| Friction policy inconnue | Sans sandbox 11/16 confirmations ; avec Gondolin attesté 0/16, sans regex ajoutée | rapports policy friction + sandbox friction |
| Backend sandbox non choisi | Gondolin/QEMU : frontières, agents structurés et snapshot verts ; exception hash-pinnée approuvée et launcher exclusif déployé | rapports Gondolin/deployment + doc B1 |
| Runner de code non sandboxé | Run invalidé, commande et script supprimés ; aucun résultat de test utilisé comme preuve | rapport `evals/reports/2026-07-20-handoff-code.json` |
| Décisions dispersées | Statut agrégé avec preuves complètes, invalidations reconnues et gate global mécanique | `npm run eval:status` + test dédié |

**Décision `trust-boundary` : rejet et retrait du package.** Le harness actuel n’a montré aucun défaut que cette extension corrige sur le corpus exécuté. Une réintroduction exigerait d’abord un échec baseline reproductible.

**Décision `review-challenge` : rejet et retrait du package.** Les idées d’invariant supprimé et de trace cross-file restent pertinentes, mais le skill global les a déjà appliquées sur le corpus, avec une suggestion valide supplémentaire et moins d’appels sur le diff correct.

**Décision `policy-gate` : laboratoire uniquement.** Sans sandbox, le gate de friction échoue toujours. Avec registre d’attestation + Gondolin actif, il passe à 0 % et une session `confirm` est verte. Aucune promotion tant que le routage sandbox n’est pas complet et validé juridiquement ; élargir les regex reste rejeté.

**Décision `/handoff` : valeur de focalisation et continuation sandboxée démontrées, maintien dans le challenger.** Le run hôte reste invalidé, mais son remplacement Gondolin réussit deux fois nominal + erreur avec beaucoup moins de contexte. Les cinq cas comportementaux, deux corrections projet et la paire projet handoff/compaction passent. Le launcher RPC gardé est désormais imposé sur les entrées CLI installées ; seule la promotion du package complet reste refusée.

**Décision `verify-runtime` : valeur partiellement démontrée, maintien manuel dans le challenger.** La séparation runtime/tests apporte un gain sur CLI et API ; aucune promotion globale avant délégation réelle à `verify-portail` et mesure reproductible durée/tokens.

Preuve technique après simplification : 41 tests unitaires/focalisés verts, e2e policy et handoff verts, trois commandes exposées via RPC, aucun appel provider dans les e2e techniques.

## 7. Conclusion

La valeur de A n’est pas « cinq ressources supplémentaires ». Elle est :

1. une primitive sûre de canonisation des cibles ;
2. un handoff local, éditable et focalisé dont la couverture factuelle égale la compaction sur une fixture ;
3. la confirmation que la revue existante couvre déjà invariant supprimé et trace cross-file sur le corpus ;
4. une vraie séparation entre tests et preuve runtime ;
5. plusieurs défauts de compatibilité découverts puis corrigés dans le harness existant.

Le reste doit être simplifié, réfuté ou maintenu hors production. Le plan B part de ces résultats, pas de la liste initiale des idées externes.
