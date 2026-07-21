# Proposition amont — parité et mode fail-closed pour `bash` RPC

Cible observée : `@earendil-works/pi-coding-agent` 0.80.10. Aucun fichier de l’installation locale n’a été modifié.

## Cause exacte

Dans `src/modes/interactive/interactive-mode.ts`, une commande `!` émet `user_bash`, puis utilise soit le résultat complet de l’extension, soit ses `BashOperations`.

Dans `src/modes/rpc/rpc-mode.ts`, le case `bash` appelle directement :

```ts
session.executeBash(command.command, undefined, {
  excludeFromContext: command.excludeFromContext,
});
```

Sans `operations`, `AgentSession.executeBash()` sélectionne `createLocalBashOperations()`. Le shell hôte est donc utilisé même si une extension sandbox intercepte correctement `user_bash` en mode interactif.

Empreintes de l’installation analysée :

- `dist/modes/rpc/rpc-mode.js` : `2001c50c4d924f330279ea4cf64e4571c403c7ea7b15797cc0ae170c5d5bf097` ;
- `dist/core/agent-session.js` : `ba869d5d61530cbb2b1653044f470c97da161777c4d5ceb538d03e5f6e713fc8` ;
- `dist/modes/interactive/interactive-mode.js` : `601952fe0a8e87530adad6f58403ce559c303e82bff948b05e9160f2614932f2`.

## Patch minimal de parité

`experiments/gondolin/upstream/pi-rpc-user-bash.patch` applique au handler RPC la même résolution que le mode interactif : émission de `user_bash`, support d’un résultat complet, transmission des opérations personnalisées, puis enregistrement du résultat.

Ce patch corrige le bypass nominal pour Gondolin, mais ne suffit pas à garantir un fail-closed général : `ExtensionRunner.emitUserBash()` absorbe actuellement les exceptions des handlers et retourne ensuite `undefined`. Une extension sandbox qui échoue pendant l’interception pourrait donc encore laisser sélectionner les opérations locales.

## API robuste proposée

Ajouter une politique explicite au runtime RPC :

```text
--rpc-shell disabled|required-extension|local
```

- `disabled` : `bash` et `abort_bash` sont refusés ;
- `required-extension` : une extension doit fournir `result` ou `operations`, sinon refus ; toute exception de handler provoque un refus ;
- `local` : comportement historique, activé explicitement pour compatibilité.

Pour l’implémenter proprement, le runner devrait pouvoir distinguer :

- aucun handler enregistré ;
- handler ayant volontairement décliné ;
- handler ayant fourni des opérations ;
- handler en erreur.

Une méthode dédiée, par exemple `emitUserBashStrict()`, éviterait de modifier silencieusement la sémantique interactive existante.

## Régressions à couvrir en amont

1. Une extension fournit des opérations sentinelles : `bash` RPC retourne leur sortie et le canary hôte reste absent.
2. Une extension fournit un résultat complet : il est enregistré une fois dans la session.
3. Le handler lève une exception en `required-extension` : réponse RPC en erreur, aucune exécution locale.
4. Aucun handler en `required-extension` : refus déterministe.
5. `disabled` refuse `bash` et `abort_bash`.
6. `local` conserve le comportement historique uniquement sur demande explicite.
7. `excludeFromContext` est conservé dans les trois chemins.

## Décision locale

Le patch n’est pas appliqué localement et n’est pas compté comme correction intégrée. `safe-rpc-launcher.mjs` reste la frontière testée. La proposition est prête à être portée en amont, mais aucun ticket ou push réseau n’a été effectué.
