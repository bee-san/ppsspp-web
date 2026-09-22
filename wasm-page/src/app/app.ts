import { afterNextRender, ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { KeysHelpComponent } from './keys-help.component';
import { AgentSettingsComponent } from './agent/agent-settings.component';
import { AgentSessionService } from './agent/agent-session.service';
import { MiningPickerComponent } from './mining/mining-picker.component';
import { MiningSessionService } from './mining/mining-session.service';
import { MiningSettingsComponent } from './mining/mining-settings.component';
import { OcrSessionService } from './ocr/ocr-session.service';
import { OcrSettingsComponent } from './ocr/ocr-settings.component';
import { PpssppRuntime } from './ppsspp-runtime';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [OcrSettingsComponent, MiningSettingsComponent, MiningPickerComponent, KeysHelpComponent, AgentSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly runtime = inject(PpssppRuntime);
  readonly ocr = inject(OcrSessionService);
  readonly mining = inject(MiningSessionService);
  readonly agent = inject(AgentSessionService);

  constructor() {
    afterNextRender(() => {
      void this.runtime
        .bootstrap()
        .then(() => {
          const host = document.getElementById('ocrOverlay');
          const tasks: Promise<unknown>[] = [this.mining.attach(), this.agent.attach()];
          if (host) tasks.push(this.ocr.attach(host));
          return Promise.all(tasks);
        })
        .catch((error: unknown) => console.error(error));
    });
  }
}
