/*
Copyright 2022 Aurora Labs
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    https://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as core from '@actions/core';
import fs from 'node:fs/promises';
import { Entity, stringifyEntityRef, RELATION_OWNED_BY, RELATION_HAS_PART, parseEntityRef } from '@backstage/catalog-model';
//import YAML from 'yaml';
import { getBackstageEntities } from '../utils/get-backstage-entities';

type MultisigSigner = {
  signer: Entity;
  owner?: Entity;
};

type MultisigInfo = {
  entity: Entity;
  signers: MultisigSigner[];
};

type ComponentMultisigs = {
  title: string;
  component: Entity;
  multisigs: MultisigInfo[];
};

type SystemComponents = {
  title: string;
  system: Entity;
  components: ComponentMultisigs[];
};

class MultisigsCollector {
  systemComponents: SystemComponents[] = [];
  private entities: Entity[] = [];
  private multisigs: Entity[] = [];

  constructor(entities: Entity[]) {
    this.entities = entities;
    this.multisigs = this.entities.filter(item => item.kind === 'API' && item?.spec?.type === 'multisig-deployment');
    this.systemComponents = this.collectSystems();
  }

  normalizeEntities(list: string[]) {
    return [...new Set(list)].sort((a, b) => a.localeCompare(b));
  }

  collectSystems() {
    const systemRefs = this.normalizeEntities(this.multisigs.map(item => item.spec!.system! as string));
    return systemRefs
      .map(systemRef => {
        const system = this.entities.find(item => stringifyEntityRef(item) === systemRef)!;
        const components = this.collectComponents(system);

        return {
          title: system.metadata.title || system.metadata.name,
          system,
          components
        };
      })
      .sort((a, b) => a.system.metadata.name.localeCompare(b.system.metadata.name));
  }

  collectComponents(system: Entity) {
    const componentRefs = (system.relations || []).filter(
      r => r.type === RELATION_HAS_PART && parseEntityRef(r.targetRef).kind === 'component'
    );
    return componentRefs
      .map(componentRef => {
        const component = this.entities.find(item => stringifyEntityRef(item) === componentRef.targetRef)!;
        return {
          title: component.metadata.title || component.metadata.name,
          component,
          multisigs: this.multisigs
            .filter(item => (item.relations || []).some(r => r.type === 'apiProvidedBy' && r.targetRef === componentRef.targetRef))
            .map(ms => ({
              entity: ms,
              signers: this.collectSigners(ms)
            }))
        };
      })
      .sort((a, b) => a.component.metadata.name.localeCompare(b.component.metadata.name));
  }

  collectSigners(multisig: Entity) {
    return (multisig.relations || [])
      .filter(r => r.type === RELATION_OWNED_BY && parseEntityRef(r.targetRef).kind !== 'group')
      .map(r => {
        const signer = this.entities.find(e => stringifyEntityRef(e) === r.targetRef)!;
        const owner = this.entities.find(e => stringifyEntityRef(e) === signer.spec!.owner)!;
        return {
          signer,
          owner
        };
      })
      .sort((a, b) => a.owner.metadata.name.localeCompare(b.owner.metadata.name));
  }
}

type BackstageExport = {
  backstage_url?: string;
  output_path?: string;
};

export const collectMultisigs = async ({ backstage_url, output_path }: BackstageExport) => {
  const entities = await getBackstageEntities({ backstage_url });

  const multisigsCollector = new MultisigsCollector(entities);
  const result = multisigsCollector.systemComponents.flatMap(system =>
    system.components.flatMap(component =>
      component.multisigs.map(ms => {
        return {
          name: ms.entity.metadata.name,
          network: ms.entity.metadata.name?.split('-')[0],
          spec: ms.entity.spec?.multisig
        };
      })
    )
  );
  core.info(`Writing ${output_path}`);

  const jsonData = JSON.stringify(result);
  await fs.writeFile(output_path || '', jsonData);

  return true;
};
