import { Module } from "@nestjs/common";

import { DatabaseService } from "./database.service";
import { UnitOfWork } from "./unit-of-work";

/**
 * Provides the Postgres connection and the transaction boundary.
 *
 * Not `@Global`: a module importing the database should be a visible line in its
 * own definition, because SAD §1.7 makes "where does this write go" a question
 * the reader should be able to answer from the module file.
 */
@Module({
  providers: [DatabaseService, UnitOfWork],
  exports: [DatabaseService, UnitOfWork],
})
export class DatabaseModule {}
