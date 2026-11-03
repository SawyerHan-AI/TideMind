// Observed schema41 structure fingerprints; no user data.
export default {
  "idx_agent_aliases_installation": {
    "type": "index",
    "table": "agent_aliases",
    "sha256": "f040033fb7a7f7460c734ecc2148d55c075dc4a6bc24f7e6b78328af50cf28ca",
    "optional": false
  },
  "idx_agent_consents_installation": {
    "type": "index",
    "table": "agent_consents",
    "sha256": "358d5abeb2200b36086c0db1d1a1ba9c9a64efc58b7c5907a963aa5ce18248c9",
    "optional": false
  },
  "idx_agent_host_activity_agent": {
    "type": "index",
    "table": "agent_host_activity_evidence",
    "sha256": "dd2fac2f305947ade80b4c8e364a70ddeb2f328764be3d5b541b7ac306a8d3e7",
    "optional": false
  },
  "idx_agent_host_activity_lookup": {
    "type": "index",
    "table": "agent_host_activity_evidence",
    "sha256": "2d08f9d5fb17b5e053a47fb081d89caca646f01ef2bbbeebee0f86910f061ec6",
    "optional": false
  },
  "idx_agent_installations_detected": {
    "type": "index",
    "table": "agent_installations",
    "sha256": "ad59c75400b19d172029f6924d57bf735e9fbda70733e65812415e1dd90eb773",
    "optional": false
  },
  "idx_agent_installations_family": {
    "type": "index",
    "table": "agent_installations",
    "sha256": "c9ba97a36209a1f6f28e7c062f84c080c3f8b1cf6ba5b3680c1e8e1114c7e6d4",
    "optional": false
  },
  "idx_agent_installations_state": {
    "type": "index",
    "table": "agent_installations",
    "sha256": "f4f265d905da757f57caf89c4b5a8a927c790d85e4126c4b876dfb2a2bf63418",
    "optional": false
  },
  "idx_agent_integration_apply_task_items_legacy_null": {
    "type": "index",
    "table": "agent_integration_apply_task_items",
    "sha256": "3798edb6f0fc9b88ab9ef458a3feebdb771af1a1688e49c2d0d3450abb1e4961",
    "optional": false
  },
  "idx_agent_integration_apply_task_items_run": {
    "type": "index",
    "table": "agent_integration_apply_task_items",
    "sha256": "91fd03f73356ae61158f30a7e9a06de5c58cba7e94cb1e997b46988f415b636c",
    "optional": false
  },
  "idx_agent_integration_apply_task_items_state": {
    "type": "index",
    "table": "agent_integration_apply_task_items",
    "sha256": "6b763ce0d6ae14848955cd43fa5f91f5a2658363ed95d533f6842fee5dc2fd64",
    "optional": false
  },
  "idx_agent_integration_apply_tasks_recent": {
    "type": "index",
    "table": "agent_integration_apply_tasks",
    "sha256": "fa5b1386c30a26c5776396843488783d10b4c37fe279eb0d5ea001478bcba79c",
    "optional": false
  },
  "idx_agent_integration_events_dedupe": {
    "type": "index",
    "table": "agent_integration_events",
    "sha256": "4838579aea35de8778f453c904933b8b65d0efe05e6a502da54b3b097e43f8c7",
    "optional": false
  },
  "idx_agent_integration_events_inbox": {
    "type": "index",
    "table": "agent_integration_events",
    "sha256": "37f7cb4a1b4cdac2ab931643a0f5ccaa0d9dd159923a03f3340f67975db74468",
    "optional": false
  },
  "idx_agent_integration_events_installation": {
    "type": "index",
    "table": "agent_integration_events",
    "sha256": "b27599b1c65dc89743cc2c55880746e377d420a62aa5317795397f2cd11e5394",
    "optional": false
  },
  "idx_agent_integration_events_missing_episode": {
    "type": "index",
    "table": "agent_integration_events",
    "sha256": "c3f63689e2f0e4d86a2f352bae06b57c7c0928ab0f87477ab38b99300f7f66a4",
    "optional": false
  },
  "idx_artifact_consumers_installation": {
    "type": "index",
    "table": "artifact_consumers",
    "sha256": "63358922545d4ba39773d7b2fe939a868071fcc473c71c8da18e6db926c81ff1",
    "optional": false
  },
  "idx_artifact_consumers_state": {
    "type": "index",
    "table": "artifact_consumers",
    "sha256": "421feab3e5b47a14b8ddae66e3cabbb0764d31a0441c7cef89e6e26c081b8b32",
    "optional": false
  },
  "idx_artifact_contributions_active": {
    "type": "index",
    "table": "artifact_contributions",
    "sha256": "64eb2dbc5878e1c8581eeffd687d6e706ab7322e2303fa4c1d0524657d8b3850",
    "optional": false
  },
  "idx_change_feed_scope": {
    "type": "index",
    "table": "change_feed",
    "sha256": "8f70cf9743365102d290e8225717ac16a3eb919fd8d324d7601897ec7fc0cdf6",
    "optional": false
  },
  "idx_cli_capacity_leases_expiry": {
    "type": "index",
    "table": "cli_capacity_leases",
    "sha256": "95bfe159e2173947839bdd9275c084042c7739c9ca08ceb316a65c47e9f8746e",
    "optional": false
  },
  "idx_cli_invocations_connection": {
    "type": "index",
    "table": "cli_invocations",
    "sha256": "b79a4071b927688ab129b1f3811d1ed09e97c6759e472d7e508f12a46f9eb69e",
    "optional": false
  },
  "idx_cli_invocations_envelope": {
    "type": "index",
    "table": "cli_invocations",
    "sha256": "3b84375ca1e57f6d8f9d5568c59b187cfc2d151992c99dac231be713cab9de00",
    "optional": false
  },
  "idx_cli_invocations_outcome": {
    "type": "index",
    "table": "cli_invocations",
    "sha256": "fbac6dc05176a5ce2c37537762cfb74c1d6f7c7aedff38cd92e8c1691927006d",
    "optional": false
  },
  "idx_cli_invocations_task": {
    "type": "index",
    "table": "cli_invocations",
    "sha256": "6c25c186e1a8a4849c1eb1d25f363577825884d18c52db5d994e091c4cc70523",
    "optional": false
  },
  "idx_dead_letter_version": {
    "type": "index",
    "table": "cloud_sync_dead_letters",
    "sha256": "9deb4c164208cfd6c946947a2725aca3bc5be758a9890a4ce10542f05c2d26b1",
    "optional": false
  },
  "idx_foreground_commands_claim": {
    "type": "index",
    "table": "foreground_commands",
    "sha256": "61234b5084702890368060b6be148ee4e148864d562f6c41da41a76730a687f0",
    "optional": false
  },
  "idx_foreground_pending_admission": {
    "type": "index",
    "table": "foreground_pending_projection",
    "sha256": "24181a605aebd3e40f947afcb78c1e5adf9d48fc47dddbc593eab3702cc3bf9e",
    "optional": false
  },
  "idx_initialization_overlays_projection": {
    "type": "index",
    "table": "initialization_overlays",
    "sha256": "a0a149b499271d32ade3ff6633dffa5da1b043d36043a9eae66ba10662fdba00",
    "optional": false
  },
  "idx_installation_components_artifact": {
    "type": "index",
    "table": "installation_components",
    "sha256": "5f904a6bedd397be19f397bed42eceecf7d7fbee35314aeb2ce849ba414d5273",
    "optional": false
  },
  "idx_installation_components_status": {
    "type": "index",
    "table": "installation_components",
    "sha256": "a446b3f7edf0b5875069a77d211f238b602e9e3b1166ebe9c77fc210559ca0da",
    "optional": false
  },
  "idx_links_from": {
    "type": "index",
    "table": "links",
    "sha256": "2bb57c6574b9580886ad48ae0e3e0a8bf97f896b0344719e85c42e0a6ca6f2b5",
    "optional": false
  },
  "idx_links_status": {
    "type": "index",
    "table": "links",
    "sha256": "fcf3e23439257a8a1a985325fb816920034adfee0380d3547ac5ebace1027e6f",
    "optional": false
  },
  "idx_links_to": {
    "type": "index",
    "table": "links",
    "sha256": "dc0dee300cd3658ef0e0a384b699e6d01bb3deb688a4878537b2c56583ab480f",
    "optional": false
  },
  "idx_llm_connection_health_connection": {
    "type": "index",
    "table": "llm_connection_health",
    "sha256": "f92c5a362d0d0237642a087da748502ed254aa75dda7a1693bb185a738591984",
    "optional": false
  },
  "idx_llm_invocation_outcome": {
    "type": "index",
    "table": "llm_invocation_attempts",
    "sha256": "48cea00aacb73f0b7b6651ddd2963fa1c799d059b66f0676b393a09699fefa37",
    "optional": false
  },
  "idx_llm_invocation_task": {
    "type": "index",
    "table": "llm_invocation_attempts",
    "sha256": "2fabe02ea38a42a0170b80e09a3b3702fbcb08b51a6dd157a43cd8b835a3ff3e",
    "optional": false
  },
  "idx_llm_invocation_workflow": {
    "type": "index",
    "table": "llm_invocation_attempts",
    "sha256": "9f4a30464d15d27704af2afc872c1b8868ca4d92adab6b0b14f7baa552109a5b",
    "optional": false
  },
  "idx_llm_model_observations_connection": {
    "type": "index",
    "table": "llm_model_observations",
    "sha256": "cd103bef8a708e1ae3b9507118d9c474290c84af63c338d0a1450ca27d3cba54",
    "optional": false
  },
  "idx_llm_usage_connection": {
    "type": "index",
    "table": "llm_usage_log",
    "sha256": "6466a8a9bcabb2248e6fec343c8f7d5037c75de540e27d5ac8222b43089c77d3",
    "optional": false
  },
  "idx_llm_usage_created": {
    "type": "index",
    "table": "llm_usage_log",
    "sha256": "2397902065cc0a864447b1a669fc26939612d9e0efa8527f1fbd911ed1d24e1a",
    "optional": false
  },
  "idx_llm_usage_invocation": {
    "type": "index",
    "table": "llm_usage_log",
    "sha256": "ed5a1be854a00bd40fb5b7cc02f040003d3c85c605b529c1f2e3b26b82339363",
    "optional": false
  },
  "idx_llm_usage_model": {
    "type": "index",
    "table": "llm_usage_log",
    "sha256": "e8b649901e4524481c04d07642f28a29a2f68438d8af9e3d4e52e065c70ab10b",
    "optional": false
  },
  "idx_llm_usage_source": {
    "type": "index",
    "table": "llm_usage_log",
    "sha256": "417143cd59596a246224a5549406e0b10d04a489a618a610d1ece31326b9bf69",
    "optional": false
  },
  "idx_llm_usage_workflow": {
    "type": "index",
    "table": "llm_usage_log",
    "sha256": "080acb2a3098a6ef77a95445d2136f9a91ebd00e84154b4233bc83862cdfdb55",
    "optional": false
  },
  "idx_maintenance_intents_claim": {
    "type": "index",
    "table": "maintenance_intents",
    "sha256": "6fbcb4fcfb207509e86ba3df3fd95054f22be70b6e9fbeaa2b89d754a29fddfe",
    "optional": false
  },
  "idx_managed_artifacts_domain": {
    "type": "index",
    "table": "managed_artifacts",
    "sha256": "adf4b0d19bb32471ede36e8953ddc7c150a461f1bc2237758944dc469a91e03b",
    "optional": false
  },
  "idx_managed_artifacts_state": {
    "type": "index",
    "table": "managed_artifacts",
    "sha256": "4ce59cc7ac0db9528b25cd18609eca08b78a06f9ab199c0266871f20dbc6e7e5",
    "optional": false
  },
  "idx_managed_artifacts_target": {
    "type": "index",
    "table": "managed_artifacts",
    "sha256": "9bdab5aa6c124dcdc2c314fdff56b5bb3abbab1f99c39647c491b9809d147512",
    "optional": false
  },
  "idx_mutation_journal_owner": {
    "type": "index",
    "table": "mutation_journal",
    "sha256": "9e8dab60d4a8be6ba4edd715a03ba5000a725c088a5523590aaa2244f5e2a8be",
    "optional": false
  },
  "idx_mutation_journal_rollback": {
    "type": "index",
    "table": "mutation_journal",
    "sha256": "d727712f3a3357dea2aa1f68b84ca46b44585fcc6e9402e30bc10a231f469f5d",
    "optional": false
  },
  "idx_nodes_active_heat": {
    "type": "index",
    "table": "nodes",
    "sha256": "0cb80de79e54a12bcc48775e03b1208a7af2709a03ff14cc11ca884af9f0c40b",
    "optional": false
  },
  "idx_nodes_active_updated": {
    "type": "index",
    "table": "nodes",
    "sha256": "716125ca25402f60b291f8c1a76c70171d89575ae49142a5f341b01171c0621a",
    "optional": false
  },
  "idx_nodes_archived": {
    "type": "index",
    "table": "nodes",
    "sha256": "2f5cd418a2b6b9f532756b76c2dd78d347f7733f0b0bf66ef25cdd7078389a95",
    "optional": false
  },
  "idx_nodes_heat": {
    "type": "index",
    "table": "nodes",
    "sha256": "96f68b06d6cb5521a258a2ef205262b4f349ef6114b7947630b1233ad1f2c84b",
    "optional": false
  },
  "idx_nodes_is_crystal": {
    "type": "index",
    "table": "nodes",
    "sha256": "5d90ebf32a18f6d0778f69c1240b69e6cb76d9bab15220a1186fff0370a2cf3e",
    "optional": false
  },
  "idx_nodes_is_meta": {
    "type": "index",
    "table": "nodes",
    "sha256": "cf1a7928af08c61b62cd93512ba32f36f9d693f8b9345a5813fd798092aed28d",
    "optional": false
  },
  "idx_nodes_is_tag": {
    "type": "index",
    "table": "nodes",
    "sha256": "f078d89c7be89ffda54c8e264e5b864de1644bd0f500dfe0940b3707a3ee5c98",
    "optional": false
  },
  "idx_nodes_keystone": {
    "type": "index",
    "table": "nodes",
    "sha256": "be2a5ee5290a7beb175f194ce3e1c0924d75d532d3e5c0978f0adb754f3dc4af",
    "optional": false
  },
  "idx_nodes_type": {
    "type": "index",
    "table": "nodes",
    "sha256": "d077a43988eda0f0f3a912cf1ed68c71341578f6329142933b54384bfae82f9e",
    "optional": false
  },
  "idx_notion_pending_retry_source": {
    "type": "index",
    "table": "notion_pending_retry",
    "sha256": "d1edc3861918d8c6b82dec65ec3859f60c9a0b2d0d9cb33fb3be5fc6fdab5681",
    "optional": false
  },
  "idx_notion_pending_target": {
    "type": "index",
    "table": "notion_pending_relations",
    "sha256": "be9f6e0adcbd194ed2be71a4ffdcb300e138c87aee55265c7c108a6c1e65f411",
    "optional": false
  },
  "idx_operation_log_invocation": {
    "type": "index",
    "table": "operation_log",
    "sha256": "085a27b949d73d3e1960e6a99576bc4b7eb1865f355d5a3efd42d8737f91e871",
    "optional": false
  },
  "idx_param_feedback_strategy": {
    "type": "index",
    "table": "param_feedback",
    "sha256": "a41ec1d74ba0b28098adf97391fcacb1ed4e3b9b4eeb8d6d500af64ac7505fee",
    "optional": false
  },
  "idx_pending_digests_status": {
    "type": "index",
    "table": "pending_digests",
    "sha256": "5556a61061900217e5a0c7bdaabcd59877afdde02d2924c0fc8bbb48090820e6",
    "optional": false
  },
  "idx_projection_mutations_domain": {
    "type": "index",
    "table": "projection_mutations",
    "sha256": "4a658baa2da8260bba6c19870bc5f87f41898b1e7d66f04466234c33e10d54b0",
    "optional": false
  },
  "idx_projection_mutations_recovery": {
    "type": "index",
    "table": "projection_mutations",
    "sha256": "122e4edb6c899b6237445cfa62e42be35740573f7ebda25b6448ab1cab15fcbf",
    "optional": false
  },
  "idx_projection_mutations_run": {
    "type": "index",
    "table": "projection_mutations",
    "sha256": "a3d5861b4545e071b3cabfd57b0035ef74f72aa0f39155d6747deadab6742441",
    "optional": false
  },
  "idx_reconcile_runs_installation": {
    "type": "index",
    "table": "reconcile_runs",
    "sha256": "5247b20d0643919a1a71b3c0830ee5425ed1e2d4dd37a0566f9be62e587a4697",
    "optional": false
  },
  "idx_reconcile_runs_legacy_correlation": {
    "type": "index",
    "table": "reconcile_runs",
    "sha256": "727e3b96299f6a7f05cd35c0b5a1f8306dd37ce59eaa469cc6ca79554260fb7d",
    "optional": false
  },
  "idx_reconcile_runs_recovery": {
    "type": "index",
    "table": "reconcile_runs",
    "sha256": "514919ab215b5ac62f20c68c77a720bd4298a2bc61cc799477e8647499bee07f",
    "optional": false
  },
  "idx_recovery_actions_claim": {
    "type": "index",
    "table": "recovery_actions",
    "sha256": "08fb6800872fc2e63bb8c7329aea81a66bfc975c3354f35012337dd6254d72bf",
    "optional": false
  },
  "idx_recovery_barriers_active": {
    "type": "index",
    "table": "recovery_barriers",
    "sha256": "c2e079a2f6280c6866b1d13b9aae9df36c0656acc0e4e6873cbfdc0e095de5fc",
    "optional": false
  },
  "idx_recovery_barriers_owner": {
    "type": "index",
    "table": "recovery_barriers",
    "sha256": "1532213a3d79bcce05d0995b814b933b183f88afbf89f879aeb85197ce4da202",
    "optional": false
  },
  "idx_recovery_reports_episode": {
    "type": "index",
    "table": "recovery_reports",
    "sha256": "fa2f6910d78321790d71aef6e6586160d49cffd68451a3f61ce1cf1a8d9c2a60",
    "optional": false
  },
  "idx_run_attempts_control": {
    "type": "index",
    "table": "run_attempts",
    "sha256": "d4e234cbfc9db3213f4a53027ccb47db4905dab441416d24f116409efb2b5ebf",
    "optional": false
  },
  "idx_run_attempts_run": {
    "type": "index",
    "table": "run_attempts",
    "sha256": "06ab16f5c401b6a75ab88cc50169cf79661c40c952efcf4ac0aa20fbd1a9dde1",
    "optional": false
  },
  "idx_runtime_instances_expiry": {
    "type": "index",
    "table": "runtime_instances",
    "sha256": "29a688fcc84af5fbc7f78724f473dec0f7f5a700268eafcc861fa1945c1ccf90",
    "optional": false
  },
  "idx_runtime_shutdowns_status": {
    "type": "index",
    "table": "runtime_shutdowns",
    "sha256": "c16fb928078abb8414948d286675116cbbd9fcad120b2117ea253538f3ff9b41",
    "optional": false
  },
  "idx_source_retry_claim": {
    "type": "index",
    "table": "source_retry_items",
    "sha256": "f036255ed4a5f3f4c4cc006cd4f130cff057f02e316d43a65e2c0fe127ca727a",
    "optional": false
  },
  "idx_strategy_versions_name": {
    "type": "index",
    "table": "strategy_versions",
    "sha256": "13af6579b2189223bca7948201021de1bd62ada48d312dde58a41dbe2dffa4e6",
    "optional": false
  },
  "idx_tag_usage_count": {
    "type": "index",
    "table": "tag_usage",
    "sha256": "109b1bdad1c53b1dd51c1662bf0c250f69cf0ef34f178568e821e42b941dccdc",
    "optional": false
  },
  "idx_task_runs_retry": {
    "type": "index",
    "table": "task_runs",
    "sha256": "aefe6a5d7ed639cb120ab3c47f82759ace226abee050d43ece2c141c4a72fb18",
    "optional": false
  },
  "idx_task_scope_generations_dirty": {
    "type": "index",
    "table": "task_scope_generations",
    "sha256": "914eaf1a6af7c6f417daafca54c00e052bc1d822f739063cd3ab0159de6a702e",
    "optional": false
  },
  "idx_timeline_created": {
    "type": "index",
    "table": "timeline_events",
    "sha256": "222c1170e0a3528c3724a3222574622ad9c807e7949f4835e1f9554baff90635",
    "optional": false
  },
  "idx_timeline_outbox_delivery": {
    "type": "index",
    "table": "timeline_outbox",
    "sha256": "0a149cd32e844fe44ca229f34eefab11a0c92203e67c044ee1f91703b0d39063",
    "optional": false
  },
  "idx_timeline_type": {
    "type": "index",
    "table": "timeline_events",
    "sha256": "4cdc6b125117247b91a95086c548cb2479f0d10fb1c471b6b2cf17412c44c34e",
    "optional": false
  },
  "idx_verification_results_component": {
    "type": "index",
    "table": "verification_results",
    "sha256": "4643ed131a925cc5908a3e69901420b926972f71e3bf8198cbcee23aad07b129",
    "optional": false
  },
  "idx_verification_results_freshness": {
    "type": "index",
    "table": "verification_results",
    "sha256": "66a04ef07743b0113c550aa98a69c58e67f91d1c9c037242b66cb964e2991809",
    "optional": false
  },
  "idx_verification_results_run_component": {
    "type": "index",
    "table": "verification_results",
    "sha256": "cf28dc5497d36f32befd18f284f714ce09f6bc093d1a9bd2d7f6b9cac900aa9e",
    "optional": false
  },
  "idx_work_items_unresolved": {
    "type": "index",
    "table": "work_items",
    "sha256": "ba80ff93497ef4b378e2365829f06a001cf711df3275639cffbd5c1c51023ccf",
    "optional": false
  },
  "idx_workflow_runs_active": {
    "type": "index",
    "table": "workflow_runs",
    "sha256": "08d20a9e4f9a414c30227efbd104e387ffe5d88820698c589a9805af2b5057cc",
    "optional": false
  },
  "idx_workflow_runs_recovery": {
    "type": "index",
    "table": "workflow_runs",
    "sha256": "0a837ac5982a96e8af3fff297b8b9f4f0a417e40e88d9a327f1c68550ff79de0",
    "optional": false
  },
  "idx_writer_fences_lease": {
    "type": "index",
    "table": "writer_fences",
    "sha256": "417f6268f5fab4904bb8761aef5d189c7feb86da9e9b4c31bdeed7f44048b94c",
    "optional": false
  },
  "agent_aliases": {
    "type": "table",
    "table": "agent_aliases",
    "sha256": "c3f303505be71f7c79528735d1829cdc85dde51bfeeaa224003b984ac1bc9f26",
    "optional": false
  },
  "agent_consents": {
    "type": "table",
    "table": "agent_consents",
    "sha256": "1be4b5d7fb9c29ad0e2fe32b947333962bccbef705be24ba2cade9800c6dbbdc",
    "optional": false
  },
  "agent_host_activity_evidence": {
    "type": "table",
    "table": "agent_host_activity_evidence",
    "sha256": "a0be0499edf8641f926fe9125f88008ee55499404a652053ddc9c946cb19643d",
    "optional": false
  },
  "agent_installations": {
    "type": "table",
    "table": "agent_installations",
    "sha256": "a79e7c6d77a52098945218d7309b7e705382d194806bfcac231132bc36098f7e",
    "optional": false
  },
  "agent_integration_apply_task_feed_state": {
    "type": "table",
    "table": "agent_integration_apply_task_feed_state",
    "sha256": "41434c02c394c374e7bd2654e1955c796d821e06029bdb0b33f34fbad4dc7ec9",
    "optional": false
  },
  "agent_integration_apply_task_items": {
    "type": "table",
    "table": "agent_integration_apply_task_items",
    "sha256": "4789466c89bdacfbe10cf337f38a468c0b58e5415268c43f6d0646c1f8324e89",
    "optional": false
  },
  "agent_integration_apply_tasks": {
    "type": "table",
    "table": "agent_integration_apply_tasks",
    "sha256": "080997147bb872f3e679830375fe712e9a0345be8a4b0337201c0305ea1abe32",
    "optional": false
  },
  "agent_integration_events": {
    "type": "table",
    "table": "agent_integration_events",
    "sha256": "0c85b17f8779c1ebb5d4ac51bdaf577aa846903eadd874d451c9ce9aac002767",
    "optional": false
  },
  "agent_npm_official_verifications": {
    "type": "table",
    "table": "agent_npm_official_verifications",
    "sha256": "113d6145a22e26ad1ca2e9133c975b2fc1e750a5cc4408587695c438211020e8",
    "optional": false
  },
  "agents": {
    "type": "table",
    "table": "agents",
    "sha256": "3e6e03e4933a377a8b4bbcc815a7a38ff9bb96f1a816c13bd6c9aa99cd0fc052",
    "optional": false
  },
  "ai_service_status": {
    "type": "table",
    "table": "ai_service_status",
    "sha256": "a9f9c8ea28326d591d1d04c5af7e239dfca88820212df2827527dcd650bf4333",
    "optional": false
  },
  "artifact_consumers": {
    "type": "table",
    "table": "artifact_consumers",
    "sha256": "5d83cd14bad2449c860910630ff3853db7b12846237be6f18740323e2dbce438",
    "optional": false
  },
  "artifact_contributions": {
    "type": "table",
    "table": "artifact_contributions",
    "sha256": "dc37db09755a018ba222db6e0f4e121e88f26e6e0a6f5c6ac2b5c7bca0e481e5",
    "optional": false
  },
  "background_schema_capabilities": {
    "type": "table",
    "table": "background_schema_capabilities",
    "sha256": "05c740c0acd53d86a5d5fae0d4f77e065058ea21687348e39666d25412377196",
    "optional": false
  },
  "change_feed": {
    "type": "table",
    "table": "change_feed",
    "sha256": "63de521dd9fb5d695bc646636836aadc84ab5e994f63c1f88db14ff3db10c371",
    "optional": false
  },
  "cli_capacity_leases": {
    "type": "table",
    "table": "cli_capacity_leases",
    "sha256": "7eda6c890f1e01ea1dc2bc1945306aa56a43ab8880454271b07dabf41c441165",
    "optional": false
  },
  "cli_invocations": {
    "type": "table",
    "table": "cli_invocations",
    "sha256": "9f566195f5263a7c193755db41522e1fb75a78cdf7816228a544d1fe63ae5c22",
    "optional": false
  },
  "cloud_dirty": {
    "type": "table",
    "table": "cloud_dirty",
    "sha256": "d6f0d223ae0945458a4f6419a5dbbbb880f38276667cc3b35dcd11b355349426",
    "optional": false
  },
  "cloud_sync_dead_letters": {
    "type": "table",
    "table": "cloud_sync_dead_letters",
    "sha256": "82b63b38e5eb6f2f596999cd9d1d5c3a125c590d3d19c629820d57ced63448ce",
    "optional": false
  },
  "foreground_commands": {
    "type": "table",
    "table": "foreground_commands",
    "sha256": "4d2cf912a1b170d5c4191f9475bd1ae0496362f2f355f776480d0f2fc92d3a43",
    "optional": false
  },
  "foreground_pending_projection": {
    "type": "table",
    "table": "foreground_pending_projection",
    "sha256": "3b61ebb6d7d73d3650856c34e155f82759512bab6c3d01764dc59e325d75c156",
    "optional": false
  },
  "foreground_queue_status": {
    "type": "table",
    "table": "foreground_queue_status",
    "sha256": "7857d75de91fa4a31bc0d0080c28c2d42533ca85615b51a385dcb421600912d4",
    "optional": false
  },
  "graph_projection_head": {
    "type": "table",
    "table": "graph_projection_head",
    "sha256": "4631781cd11936fe05ce3cc035f33e5bd0efadc9ba1fe66837e1b56c1e5b61e5",
    "optional": false
  },
  "graph_scope_generations": {
    "type": "table",
    "table": "graph_scope_generations",
    "sha256": "b9d31bbd35052013e8bbe6b81a14a5d9706f023cbbbcd30de8ae9c37e43f73bc",
    "optional": false
  },
  "initialization_overlays": {
    "type": "table",
    "table": "initialization_overlays",
    "sha256": "0aba052825294f06c5b44ca34ed009e278b3a2c53ba7630c60b16ac35d3ff2f9",
    "optional": false
  },
  "installation_components": {
    "type": "table",
    "table": "installation_components",
    "sha256": "7250d2d0c66548548ac7c391046ef3a79645db1d21733d9235697f22ee92921a",
    "optional": false
  },
  "links": {
    "type": "table",
    "table": "links",
    "sha256": "e4598f43d02f4b992c52938d185a5c25bda9b1fa6cc51c45dcc347a511956fdc",
    "optional": false
  },
  "llm_connection_auth_bindings": {
    "type": "table",
    "table": "llm_connection_auth_bindings",
    "sha256": "e23c43f3bb3047ddc0dae8c2afdfb3f49d0c10d11c46800d3ce27c4abad699e8",
    "optional": false
  },
  "llm_connection_health": {
    "type": "table",
    "table": "llm_connection_health",
    "sha256": "35e8d001c8c6e55ae779792ef019d1f3d93d22bd8d5d15118dfb61ffa2463b68",
    "optional": false
  },
  "llm_connection_probe_leases": {
    "type": "table",
    "table": "llm_connection_probe_leases",
    "sha256": "0b8dcf7ce39aa9ae57ba800fddd02899d42d8666c8f3cb5feaed815522d2e7d8",
    "optional": false
  },
  "llm_invocation_attempts": {
    "type": "table",
    "table": "llm_invocation_attempts",
    "sha256": "c8d999ecd2f31a098cbd0b2b7116ece7400fd10938c978f33336847016d07f98",
    "optional": false
  },
  "llm_model_catalog_snapshots": {
    "type": "table",
    "table": "llm_model_catalog_snapshots",
    "sha256": "c2f51a9b3532a64bf8713ad69a7c9b75e922602e08e2334a1f47123b230d2c2c",
    "optional": false
  },
  "llm_model_observations": {
    "type": "table",
    "table": "llm_model_observations",
    "sha256": "edda341e5cddf1faae9c16579a7fc096c76b55ea85c79e016976909eed08230c",
    "optional": false
  },
  "llm_usage_log": {
    "type": "table",
    "table": "llm_usage_log",
    "sha256": "840ca86b8aef6b05824b914a16bf2695213e7c87e2449ca7300abd92fd5b6558",
    "optional": false
  },
  "local_outbox": {
    "type": "table",
    "table": "local_outbox",
    "sha256": "1b0bbd3102a25af92d2caf4b6a8f7ccbcb52f9d078b9233436c80223d24056d0",
    "optional": false
  },
  "local_outbox_dead": {
    "type": "table",
    "table": "local_outbox_dead",
    "sha256": "4e2d616cfb203a824e5e41c6586a36a61959c9a0233f1ef75305ef98c08b2649",
    "optional": false
  },
  "logseq_sync": {
    "type": "table",
    "table": "logseq_sync",
    "sha256": "b80bf4b0ede5114209ff060a0366757fd8cf828cd1336ba95736b80f36ef41d8",
    "optional": false
  },
  "maintenance_intents": {
    "type": "table",
    "table": "maintenance_intents",
    "sha256": "7bfc36d33c48e84455d4826f855dde227bc860b4f3ecf39745ed9add5a9f9614",
    "optional": false
  },
  "managed_artifacts": {
    "type": "table",
    "table": "managed_artifacts",
    "sha256": "54fe543c95a67602a40008cdd8479ea341033b30aaa96bbc589c7e30704fb726",
    "optional": false
  },
  "metadata": {
    "type": "table",
    "table": "metadata",
    "sha256": "3dab099747d89eff4f5a29d5dcd713c8e97a497924b8c58abfc1229e6b5f5b04",
    "optional": false
  },
  "model_connections": {
    "type": "table",
    "table": "model_connections",
    "sha256": "3ae1c62dd0c20cafdd05fc5de3bbea0cb6af7a0b14a97ae3e039303d56ecea16",
    "optional": false
  },
  "mutation_journal": {
    "type": "table",
    "table": "mutation_journal",
    "sha256": "0a2cd8c7fdc9c0a35eb11dfd76c3ecd46ee2ea379c6f7ade8033e93b475a25fc",
    "optional": false
  },
  "mutation_lane": {
    "type": "table",
    "table": "mutation_lane",
    "sha256": "a774b80618b4646a4e3c7678e15eadc8f0279acb054242b6646bc0a5beed3a05",
    "optional": false
  },
  "node_segments": {
    "type": "table",
    "table": "node_segments",
    "sha256": "3f5e4632f1ccf2a6b897336ea1b86bf3e563c1366d26f5d1f6c989a613f622f1",
    "optional": false
  },
  "node_versions": {
    "type": "table",
    "table": "node_versions",
    "sha256": "7ba03a237b708957698deba9f8b38be7b32b5417dba4cc5a44321a75316c1d22",
    "optional": false
  },
  "nodes": {
    "type": "table",
    "table": "nodes",
    "sha256": "7e1549e5b924117b5f278e2acd3cb2014e0d40aa90b1bbba3be6e232fbb1c4c5",
    "optional": false
  },
  "nodes_fts": {
    "type": "table",
    "table": "nodes_fts",
    "sha256": "f4fdb1b2e998781a71b3cff14da0c8be7e507a173765c090c2c10066c7f19307",
    "optional": true
  },
  "nodes_fts_config": {
    "type": "table",
    "table": "nodes_fts_config",
    "sha256": "db3a254ad7f05f691087ca6535231c47c041ec02f3a3f069fdece7e4e1acee51",
    "optional": true
  },
  "nodes_fts_data": {
    "type": "table",
    "table": "nodes_fts_data",
    "sha256": "c85e19eaee39f5dfba906e0c4fe4a6867345e7a5fb016e6bed406e34237cdf17",
    "optional": true
  },
  "nodes_fts_docsize": {
    "type": "table",
    "table": "nodes_fts_docsize",
    "sha256": "3addae22b256c839326437223276483f1088650e0fceeeedef778f75361f890a",
    "optional": true
  },
  "nodes_fts_idx": {
    "type": "table",
    "table": "nodes_fts_idx",
    "sha256": "a4199a5ecb434e7248a4d32a0e7236338e7d491542c09596321426eee69d9289",
    "optional": true
  },
  "nodes_vec": {
    "type": "table",
    "table": "nodes_vec",
    "sha256": "e21a504e22671f1ab84751b08b105e83dd2eba772773b894aa226dd257b4393e",
    "optional": true
  },
  "nodes_vec_chunks": {
    "type": "table",
    "table": "nodes_vec_chunks",
    "sha256": "dd3561b1e60b571ccab92aca30e8de1e3bf0c4b6ecd311f552d77789d313152e",
    "optional": true
  },
  "nodes_vec_info": {
    "type": "table",
    "table": "nodes_vec_info",
    "sha256": "98da9b47398415f13428cd0b7a26c02216dd1a794960353a9e5bd55d3c30b6ac",
    "optional": true
  },
  "nodes_vec_rowids": {
    "type": "table",
    "table": "nodes_vec_rowids",
    "sha256": "6f01b78b3834da48a6a0ee3f84bbfc06ca217850566aacf30fe06cd7d1e27445",
    "optional": true
  },
  "nodes_vec_vector_chunks00": {
    "type": "table",
    "table": "nodes_vec_vector_chunks00",
    "sha256": "73e9e548b3270dcb912ed28a136e5f5cd46c04dd44bef3f8ffd450909d7fb9fd",
    "optional": true
  },
  "note_sources": {
    "type": "table",
    "table": "note_sources",
    "sha256": "fd4831c90a81294a2135a9329047cd08f8d70eb80b2e05edaad1a134e269d895",
    "optional": false
  },
  "notion_pending_relations": {
    "type": "table",
    "table": "notion_pending_relations",
    "sha256": "542840f8405d0c2e9b3821b3192ff8729af5d73a96e5e3b658ddc825ce841c66",
    "optional": false
  },
  "notion_pending_retry": {
    "type": "table",
    "table": "notion_pending_retry",
    "sha256": "ac2c66e7b2768304950b4cbd69a1226a82085b9bc0004bc4e788a9c714a7bb85",
    "optional": false
  },
  "notion_sync": {
    "type": "table",
    "table": "notion_sync",
    "sha256": "90c0ee2a01e6225284c07cceee91b4617ffcf20daf59f9640fae38d7988b9b13",
    "optional": false
  },
  "operation_log": {
    "type": "table",
    "table": "operation_log",
    "sha256": "53260871ba467a9e75605307aac76ca065031bc2eb0aa57172070acfcdd55159",
    "optional": false
  },
  "overlay_compaction_checkpoints": {
    "type": "table",
    "table": "overlay_compaction_checkpoints",
    "sha256": "96629dc9ce7c58f975bd27b65bbc9109fce6d1208ceaf28ef45fabea07110f85",
    "optional": false
  },
  "param_adjustments": {
    "type": "table",
    "table": "param_adjustments",
    "sha256": "0f12380c0588cce3d9926b6fb6ed1a074f4b7443d3d7a21c7e7d803279fb9be7",
    "optional": false
  },
  "param_feedback": {
    "type": "table",
    "table": "param_feedback",
    "sha256": "09774efbcd2857ea492fe3457713aa75ffd0613b073054a078999e84cfaaec9a",
    "optional": false
  },
  "pending_digests": {
    "type": "table",
    "table": "pending_digests",
    "sha256": "0bd3070694a4509ba01fbe2a02405041802a80c540277439739fa5f23b82f961",
    "optional": false
  },
  "projection_mutations": {
    "type": "table",
    "table": "projection_mutations",
    "sha256": "1d90e77b67e9b385576683db002a7a1128b16b685fc3554df6243a701c1b5b83",
    "optional": false
  },
  "reconcile_runs": {
    "type": "table",
    "table": "reconcile_runs",
    "sha256": "2a712090c90d0476c9972007180e1e899b1f52dda1bc98324f13c03fc3715afe",
    "optional": false
  },
  "recovery_actions": {
    "type": "table",
    "table": "recovery_actions",
    "sha256": "4132bf7d28fb92cb803a95657a988795291fac033d1ecf8640202fad39637ccc",
    "optional": false
  },
  "recovery_barriers": {
    "type": "table",
    "table": "recovery_barriers",
    "sha256": "7dacc26f2cd4cecf5ce8e8cda06b648f7b27b6914e3c58926924612910a15b2f",
    "optional": false
  },
  "recovery_control_commands": {
    "type": "table",
    "table": "recovery_control_commands",
    "sha256": "0c5128c330f3cc4cf91695f84dcfbf6bbb4891fb23bb8fde27ed278b1184bd19",
    "optional": false
  },
  "recovery_episodes": {
    "type": "table",
    "table": "recovery_episodes",
    "sha256": "334f9be6880af93de4a77b7e6a2d4f8321e81f606e90d4e3b2e8807309349118",
    "optional": false
  },
  "recovery_reports": {
    "type": "table",
    "table": "recovery_reports",
    "sha256": "eef71d926672de4ce77184d4c3ae3d49047968785d89577c01fc0937fdf52f40",
    "optional": false
  },
  "run_attempts": {
    "type": "table",
    "table": "run_attempts",
    "sha256": "812620d6a0c7d4e8cbf91c6803b20a5502a5924aadc9c56145f4d61c8f0bd9fd",
    "optional": false
  },
  "runtime_instances": {
    "type": "table",
    "table": "runtime_instances",
    "sha256": "14dea4d13bce271b23fc07d5199678425f52eba592fa93b88692084c0855787c",
    "optional": false
  },
  "runtime_leader": {
    "type": "table",
    "table": "runtime_leader",
    "sha256": "cf7a8fda34bb4efc77389456eb4434c70f2a987b11c1815a19d720bc3851f4f9",
    "optional": false
  },
  "runtime_readiness": {
    "type": "table",
    "table": "runtime_readiness",
    "sha256": "d81955ae922467c66299a4e3880fb1f268c448c1402cc9a9fd66df7140639beb",
    "optional": false
  },
  "runtime_shutdowns": {
    "type": "table",
    "table": "runtime_shutdowns",
    "sha256": "906f02c6acf0aade2ba1d6f2b9dc60ede5f7e1bc4efd977f542a2c83f8c3f7eb",
    "optional": false
  },
  "runtime_status": {
    "type": "table",
    "table": "runtime_status",
    "sha256": "5fce552fd3883f77a60964a5f2cf0d296716768e44a46c8ff2cf817dfe751121",
    "optional": false
  },
  "source_retry_items": {
    "type": "table",
    "table": "source_retry_items",
    "sha256": "6f4be1835b1136fdd9f7ed72f1ccc43aad5dd61bbb02b47cae57e612a7036696",
    "optional": false
  },
  "source_status_projection": {
    "type": "table",
    "table": "source_status_projection",
    "sha256": "bc9c08b36928aa193b2473b819ac25131d432dc6615be33749461a0f9ece46e3",
    "optional": false
  },
  "source_workflow_status": {
    "type": "table",
    "table": "source_workflow_status",
    "sha256": "4147e9448ca8d61c42b60884110a59ec5b7139cc08ec17989634e28d2060cfd7",
    "optional": false
  },
  "strategy_feedback": {
    "type": "table",
    "table": "strategy_feedback",
    "sha256": "b102b67cd5b9722376a11d4445d4a018da74c0082be7bb1a9ed83410e8e3195b",
    "optional": false
  },
  "strategy_versions": {
    "type": "table",
    "table": "strategy_versions",
    "sha256": "135f176c4682afa239be55bbeafa50af0327ef728e95b075f44f22678b6d2ba6",
    "optional": false
  },
  "structure_holes_cache": {
    "type": "table",
    "table": "structure_holes_cache",
    "sha256": "4aee5a791fb360d8c8b7c73b73c72f02612ddc73ab1e09640b139a359fd295de",
    "optional": false
  },
  "sync_apply_guard": {
    "type": "table",
    "table": "sync_apply_guard",
    "sha256": "a732493fbe3e822d373b068bd9802ebdbb7dc2842246b274575b73d45965e104",
    "optional": false
  },
  "sync_hashes": {
    "type": "table",
    "table": "sync_hashes",
    "sha256": "33c336e20f8d4eb6910d9d6a9b74a98a2477a8e15ba4e558810f50a48e8a9635",
    "optional": false
  },
  "tag_usage": {
    "type": "table",
    "table": "tag_usage",
    "sha256": "79bcf09c726cabc15a12032fe1642ab2ae8c7202a04ceacba0751c55a654dbb1",
    "optional": false
  },
  "task_runs": {
    "type": "table",
    "table": "task_runs",
    "sha256": "27684f32ca75d2eeb9558a53f3e0a748418b017ccf3ef63135bf6daecea5d44a",
    "optional": false
  },
  "task_scope_generations": {
    "type": "table",
    "table": "task_scope_generations",
    "sha256": "70ea95a340337bf10c11c3dd6ccafbdbe0c033806f0e406510e372cb88602220",
    "optional": false
  },
  "timeline_events": {
    "type": "table",
    "table": "timeline_events",
    "sha256": "308dd48c39d78a996879ee34e41309e691f62e47d7deade51239ec1c2e93ac2c",
    "optional": false
  },
  "timeline_outbox": {
    "type": "table",
    "table": "timeline_outbox",
    "sha256": "b5aed6e45a6da1422c9c16c3145cfd71722f70149a824caea5b58be054af9dad",
    "optional": false
  },
  "verification_results": {
    "type": "table",
    "table": "verification_results",
    "sha256": "2c0b72bd49977e334dd60dbf3add5652fe2f489bf7fcab3d06f1de254f852520",
    "optional": false
  },
  "work_items": {
    "type": "table",
    "table": "work_items",
    "sha256": "ff84ee5b73600e430ed218370a91fdcb99d5bc7a536f4042971175a82f2c2da2",
    "optional": false
  },
  "workflow_inputs": {
    "type": "table",
    "table": "workflow_inputs",
    "sha256": "1eeafbd16d8be87173a03d6920c3cb3891271b1d55b78b351c18fa5fce42a6dc",
    "optional": false
  },
  "workflow_runs": {
    "type": "table",
    "table": "workflow_runs",
    "sha256": "21f665e9bdd04c980d05d78053554def94840eda588abf160aa133f65e6afcfe",
    "optional": false
  },
  "writer_fences": {
    "type": "table",
    "table": "writer_fences",
    "sha256": "1075a8013d9c09606ce261023afee9e49f94ec64f76049254b8d4296621906a3",
    "optional": false
  },
  "nodes_ad": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "f6390b962b0af06eb9cd6e8e2c9f8195ad26ccaf27f40bf1e276d22cd6df120a",
    "optional": false
  },
  "nodes_ai": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "e543a55f5edaa3ec1f8f9d986a7c446e358d35f39ab2cfb6f81562af6ce89500",
    "optional": false
  },
  "nodes_au": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "b420158676b33e1decc3e22ba30b111dabfd4aaaafa5dd9a92d3e9be6babd753",
    "optional": false
  },
  "tm_recovery_barrier_protect_active_delete": {
    "type": "trigger",
    "table": "recovery_barriers",
    "sha256": "70bed0834e5e8968e006547f7059c0f1a96c05042fb66f0e60802bfbabb4c0ed",
    "optional": false
  },
  "tm_recovery_barrier_protect_active_update": {
    "type": "trigger",
    "table": "recovery_barriers",
    "sha256": "a51d43fcc4d73425b4bb0c3a6ee5660ee1ebabd7a123cc9a9159d3851bd6c41c",
    "optional": false
  },
  "tm_recovery_barrier_protect_projection": {
    "type": "trigger",
    "table": "background_schema_capabilities",
    "sha256": "2878ac6652b7b3bbaf6f0fc0bb7fa07ce44b75725b3c69abfac463fbc2860667",
    "optional": false
  },
  "tm_recovery_barrier_sync_delete": {
    "type": "trigger",
    "table": "recovery_barriers",
    "sha256": "83769d4f78ac126a2ac0920a4920d2ed1751f80992dbff9f484405efd33a211e",
    "optional": false
  },
  "tm_recovery_barrier_sync_insert": {
    "type": "trigger",
    "table": "recovery_barriers",
    "sha256": "36ef71d873a65e40b0cb73c06961b73d7af41110724729ba5d884915a4dd2bb7",
    "optional": false
  },
  "tm_recovery_barrier_sync_update": {
    "type": "trigger",
    "table": "recovery_barriers",
    "sha256": "16033815331c53c83eb21e558c38becb37183467cd8655a032683b0102803b53",
    "optional": false
  },
  "tm_validate_task_state_insert": {
    "type": "trigger",
    "table": "task_runs",
    "sha256": "8938f8df7f690ae7c19e2a6551d04e6f3ade9e3358b2857fde28f9046ca7181e",
    "optional": false
  },
  "tm_validate_task_state_update": {
    "type": "trigger",
    "table": "task_runs",
    "sha256": "b7e927da82f951906fb73a9567549b9d81c94f38dc3ac1cb6f9caf236d53d51f",
    "optional": false
  },
  "tm_validate_work_item_state_insert": {
    "type": "trigger",
    "table": "work_items",
    "sha256": "f23879d0549976e0c29feeb8a819f3c735d54d57eebd9f514ad77618dfc054dd",
    "optional": false
  },
  "tm_validate_work_item_state_update": {
    "type": "trigger",
    "table": "work_items",
    "sha256": "51f97503a006f3826eb57676ef8b9f4225f1a0fa6bb06c92c533b6b05623048e",
    "optional": false
  },
  "tm_validate_workflow_status_insert": {
    "type": "trigger",
    "table": "workflow_runs",
    "sha256": "1fd6783e44c5c314aaa66392c2f8dfe3b1f137d8e0046fd14fbf9196f9a8d5bc",
    "optional": false
  },
  "tm_validate_workflow_status_update": {
    "type": "trigger",
    "table": "workflow_runs",
    "sha256": "3af29ba31ebe53afc32114f424ce636f55fa1cae6d579b0201a0c3b989f3fb9e",
    "optional": false
  },
  "trg_agent_apply_items_feed_delete": {
    "type": "trigger",
    "table": "agent_integration_apply_task_items",
    "sha256": "e3a917035519a6d1170385e2c020f3585200c977ad1102ad2643b70ea10373f8",
    "optional": false
  },
  "trg_agent_apply_items_feed_insert": {
    "type": "trigger",
    "table": "agent_integration_apply_task_items",
    "sha256": "9000152ca5b541368835625a0db3e59532755dc87dcc395a73c6d5f8c7c49120",
    "optional": false
  },
  "trg_agent_apply_items_feed_update": {
    "type": "trigger",
    "table": "agent_integration_apply_task_items",
    "sha256": "3c2ba7287fed01c4f614135252453533e52d25fbf8231e212a9e2f9a85f6779d",
    "optional": false
  },
  "trg_agent_apply_tasks_feed_delete": {
    "type": "trigger",
    "table": "agent_integration_apply_tasks",
    "sha256": "12d58f2c8824c505c5708dbf8b31a569d6cb86cc20e5d55638abe7606db0708d",
    "optional": false
  },
  "trg_agent_apply_tasks_feed_insert": {
    "type": "trigger",
    "table": "agent_integration_apply_tasks",
    "sha256": "af8e28b65a683c1f365a02cf5ab6b78d251f7dceb8a102cb81be608183006655",
    "optional": false
  },
  "trg_agent_apply_tasks_feed_update": {
    "type": "trigger",
    "table": "agent_integration_apply_tasks",
    "sha256": "5036aa217cc22840554ccf12f40cdc0f05bf21e807327656c11214531c98a2db",
    "optional": false
  },
  "trg_agent_connect_runs_feed_delete": {
    "type": "trigger",
    "table": "reconcile_runs",
    "sha256": "b2cec21d109b2596ba8540e8644a510226995d9b8d9355519c97654ce590d847",
    "optional": false
  },
  "trg_agent_connect_runs_feed_insert": {
    "type": "trigger",
    "table": "reconcile_runs",
    "sha256": "f8cb69212768f3dac712036d7218da4f2ae3fde03153d10c8556e2bb883a9be9",
    "optional": false
  },
  "trg_agent_connect_runs_feed_update": {
    "type": "trigger",
    "table": "reconcile_runs",
    "sha256": "5ff82a69636758df373e10dad6927596d56ba6a501e4da9d1a3bb4e1761a0943",
    "optional": false
  },
  "trg_links_dirty_ins": {
    "type": "trigger",
    "table": "links",
    "sha256": "27776e6005cb12406f8f0f328b6830fb5f19e4c6870b0e0f1fd8bf5956fe201e",
    "optional": false
  },
  "trg_links_dirty_upd": {
    "type": "trigger",
    "table": "links",
    "sha256": "89c3c01bc0a5c3b61034a5b506a57d726d34943d661346dc8e3cb8a4de371a96",
    "optional": false
  },
  "trg_nodes_dirty_ins": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "9f0fc18891d65a144381b0cb492129d42a19ae21f70f93c42cad1865718fa3e6",
    "optional": false
  },
  "trg_nodes_dirty_upd": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "7fbde28fe5f74980a8c894207e433fa860dff612e3ff995264b5875ec04b9d9f",
    "optional": false
  },
  "trg_nodes_heat_clamp_insert": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "11b88f5cc64661d886d5095548127d1e18f98da2981857941b9f3c834a98b473",
    "optional": false
  },
  "trg_nodes_heat_clamp_update": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "0fbd948341d7c52d914d2118590766c16002c40259aa91117979b81f099eac3a",
    "optional": false
  },
  "trg_reconcile_runs_verification_delete": {
    "type": "trigger",
    "table": "reconcile_runs",
    "sha256": "f93e0d8fda16224589c271e4e961045656c255e42a5a95a287ca28fab42f5eb1",
    "optional": false
  },
  "trg_tag_usage_after_delete": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "5156e807fdb37f3269c29f89a509d04fe8c8ff48ded1b62f9996981fabfd8d12",
    "optional": false
  },
  "trg_tag_usage_after_insert": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "578f8d739a084a77c76aafac87e7100ed923c1a2156749969cf18a3b6f2fad9c",
    "optional": false
  },
  "trg_tag_usage_after_update": {
    "type": "trigger",
    "table": "nodes",
    "sha256": "3e4cb4ca92ed0ccf0818fbe3127d068fd69e67c13cea88c5bff8cc9270d32e17",
    "optional": false
  },
  "trg_verification_results_run_insert": {
    "type": "trigger",
    "table": "verification_results",
    "sha256": "dfd242f03d73862040b4fc7c4a258fd378a08a69c1c6c1f0913bd291021969c0",
    "optional": false
  },
  "trg_verification_results_run_update": {
    "type": "trigger",
    "table": "verification_results",
    "sha256": "f58135d33666161a61291ea29e33c64fd5d13e235f41a74d985600c0901b7cf9",
    "optional": false
  }
};
