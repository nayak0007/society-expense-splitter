import { Ionicons } from '@expo/vector-icons';
import type { DocumentPickerAsset } from 'expo-document-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { csvErrorHeadline } from '@/features/members/services/member-import.service';
import type { PickedCsv } from '@/features/members/services/member-import.service';
import {
  useImportMembersFromCsv,
  usePreviewMemberImport,
} from '@/features/members/hooks/use-member-import';

/**
 * Bulk member import (Roadmap T048; PRD §3.2 step 4: bulk import by CSV with a dry-run
 * preview).
 *
 * ## The flow is the Roadmap's, screen by screen
 *
 * Pick file → **Preview** (the mandatory dry run: every row classified, nothing written)
 * → per-row errors beside their line numbers → **Confirm** → results with the same
 * arithmetic (`total = imported + invalid + conflicts`). The preview is the safety bar: an
 * admin cannot reach the import without having been shown exactly which rows will fail,
 * and the import's per-row failures repeat them because "nothing silently dropped" is a
 * property of the *result* too.
 *
 * ## The device only reads text
 *
 * The picked file is read to UTF-8 text and sent whole; the server is the parser, the
 * validator and the writer. A phone that parsed and persisted memberships itself would be
 * a second membership mechanism, and the CSV grammar would then be enforced by two
 * implementations that could disagree.
 *
 * ## Row errors are grouped, not dumped
 *
 * The error list is sorted by line, each row is one headline (`csvErrorHeadline`) plus the
 * server's own sentence, so "Row 12 — Phone not usable: Include the country code…" is
 * readable at a glance. No code, no SQL, no stack — the message was written for the admin.
 */
type Phase = 'pick' | 'preview' | 'result';

interface RowProblem {
  readonly line: number;
  readonly headline: string;
  readonly message: string;
}

export default function MemberImportScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<PickedCsv | null>(null);
  const [problems, setProblems] = useState<readonly RowProblem[]>([]);

  const previewImport = usePreviewMemberImport();
  const importMembers = useImportMembersFromCsv();

  const pickFile = async (): Promise<void> => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/csv', 'text/comma-separated-values', 'text/plain'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;

    const asset: DocumentPickerAsset = result.assets[0]!;
    if (asset.size !== undefined && asset.size > 1_000_000) {
      setProblems([
        {
          line: 0,
          headline: 'File too large',
          message: 'Split the file into batches of up to 1,000 rows.',
        },
      ]);
      setPhase('preview');
      return;
    }

    // The picker hands back a `uri`; the text is read with fetch's file support, which
    // React Native provides for local file URIs — no second filesystem dependency.
    const text = await (await fetch(asset.uri)).text();
    const picked: PickedCsv = { fileName: asset.name, text };
    setFile(picked);
    setProblems([]);
    previewImport.mutate(picked, {
      onSuccess: (preview) => {
        setProblems(
          preview.rows
            .filter((row) => row.status !== 'valid')
            .map((row) => ({
              line: row.line,
              headline: csvErrorHeadline(row.error.code),
              message: row.error.message,
            })),
        );
        setPhase('preview');
      },
      onError: () => {
        setProblems([
          {
            line: 0,
            headline: 'Could not read that file',
            message: 'Make sure it is a CSV exported from your spreadsheet.',
          },
        ]);
        setPhase('preview');
      },
    });
  };

  const confirm = (): void => {
    if (file === null) return;
    importMembers.mutate(file, {
      onSuccess: (result) => {
        setProblems(
          result.failed.map((failure) => ({
            line: failure.line,
            headline: csvErrorHeadline(failure.error.code),
            message: failure.error.message,
          })),
        );
        setPhase('result');
      },
      onError: () => {
        setProblems([
          {
            line: 0,
            headline: 'Import failed',
            message: 'Nothing was changed. Try again in a moment.',
          },
        ]);
        setPhase('result');
      },
    });
  };

  const busy = previewImport.isPending || importMembers.isPending;
  const summary = phase === 'result' ? importMembers.data?.summary : previewImport.data?.summary;

  return (
    <ScrollView contentContainerClassName="p-lg gap-4">
      <Stack.Screen options={{ title: 'Import members' }} />

      {phase === 'pick' ? (
        <>
          <Text variant="bodyMedium">
            Import many members from a spreadsheet. Every row is checked before anything is saved —
            you will see exactly what will be imported first.
          </Text>
          <Card>
            <View className="gap-2">
              <Text variant="titleSmall">Columns</Text>
              <Text variant="bodySmall" color="onSurfaceVariant">
                {`flat_no, name, phone, email, occupancy_type\n\nname and phone are required; phone accepts 98765 43210 or +91 98765 43210. occupancy_type is one of owner_occupied, tenant, family_member, vacant_owner. At most 1,000 rows per file.`}
              </Text>
            </View>
          </Card>
          <Button onPress={() => void pickFile()} disabled={busy}>
            Choose a CSV file
          </Button>
          {previewImport.isPending ? (
            <Text variant="bodySmall" color="onSurfaceVariant">
              Checking the file…
            </Text>
          ) : null}
        </>
      ) : null}

      {phase !== 'pick' && summary !== undefined ? (
        <Card>
          <View className="gap-1">
            <Text variant="titleSmall">{phase === 'result' ? 'Imported' : 'Ready to import'}</Text>
            <Text variant="bodySmall" color="onSurfaceVariant">
              {`${summary.totalRows} rows in the file · ${summary.imported} imported · ${summary.invalidRows} invalid · ${summary.conflicts} conflicts`}
            </Text>
            {phase === 'preview' && file !== null ? (
              <Text variant="bodySmall" color="onSurfaceVariant">
                {file.fileName} — nothing has been saved yet.
              </Text>
            ) : null}
          </View>
        </Card>
      ) : null}

      {problems.length > 0 ? (
        <View className="gap-2">
          <Text variant="titleSmall">
            {phase === 'result' ? 'Rows not imported' : 'Rows that will be skipped'}
          </Text>
          {problems.map((problem) => (
            <Card key={`${problem.line}-${problem.headline}`}>
              <View className="gap-0.5">
                <Text variant="labelLarge">
                  {problem.line > 0 ? `Line ${problem.line}` : 'File'}
                </Text>
                <Text variant="bodySmall">{problem.headline}</Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {problem.message}
                </Text>
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {phase === 'preview' ? (
        <View className="gap-2">
          <Button onPress={confirm} disabled={busy || file === null}>
            {`Import ${summary?.validRows ?? 0} members`}
          </Button>
          <Button
            variant="text"
            onPress={() => {
              setPhase('pick');
              setFile(null);
              setProblems([]);
            }}
            disabled={busy}
          >
            Pick a different file
          </Button>
        </View>
      ) : null}

      {phase === 'result' ? (
        <View className="gap-2">
          <Button onPress={() => router.back()}>Done</Button>
          <Button
            variant="text"
            onPress={() => {
              setPhase('pick');
              setFile(null);
              setProblems([]);
            }}
          >
            Import another file
          </Button>
        </View>
      ) : null}

      {phase === 'pick' ? (
        <View className="flex-row items-center gap-2 px-2">
          <Ionicons name="shield-checkmark-outline" size={16} />
          <Text variant="bodySmall" color="onSurfaceVariant">
            Nothing is saved until you confirm.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
